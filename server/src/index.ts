import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { SessionManager } from "./sessionManager.js";
import { testAllClis, type CliTestResult, type CliName, type CliStatus } from "./cliTester.js";
import { loadConfig, saveConfig, resetConfig, getDefaults, validateConfig, type UltraPlanConfig } from "./configManager.js";

const manager = new SessionManager();
let lastTestResult: CliTestResult | null = null;
let testInProgress = false;
const port = Number(process.env.PORT ?? 8787);
const IS_WINDOWS = process.platform === "win32";

const [, , mode, ...rest] = process.argv;

if (mode === "run") {
  const cmd = rest[0];
  const args = rest.slice(1);
  if (!cmd) {
    console.error("Usage: npm run dev -- run <cmd> [args...]");
    process.exit(1);
  }

  const session = manager.create({ cmd, args, cwd: process.cwd() });
  session.on("data", (data: string) => {
    process.stdout.write(data);
  });
  session.on("exit", ({ code, signal }) => {
    const exitCode = code ?? 0;
    console.log(`[session] exited code=${exitCode} signal=${signal ?? "none"}`);
    process.exit(exitCode);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    session.write(chunk.toString());
  });
  process.stdin.resume();
  process.on("SIGINT", () => {
    session.signal("SIGINT");
  });
  process.on("SIGTERM", () => {
    session.signal("SIGTERM");
  });
} else {
  // ---- Determine project path ----
  // First non-"run" argument is treated as project path; fallback to cwd
  const projectPath = mode && mode !== "run" ? path.resolve(mode) : process.cwd();

  // Ensure projectPath exists (e.g. user may pass a new project directory)
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath, { recursive: true });
    console.log(`[server] created project directory: ${projectPath}`);
  }

  // ---- Parse initial question (second positional arg) ----
  const initialQuestion: string | null = rest[0]?.trim() || null;
  if (initialQuestion) {
    console.log(`[config] Initial question: "${initialQuestion}"`);
  }

  // ---- Resolve web/dist directory for static file serving ----
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const projectRoot = path.resolve(serverDir, "..");
  const webDistDir = path.join(projectRoot, "web", "dist");

  // ---- Auto-create sessions ----
  const autoSessionIds = { claude: "claude-auto", codex: "codex-auto", gemini: "gemini-auto" };

  /**
   * Session modes:
   * - "interactive": CLI runs directly in PTY, raw stdin input (Codex)
   * - "shell": PTY runs cmd.exe/sh, CLI commands are constructed per-prompt (Claude, Gemini)
   *
   * Claude and Gemini use Ink/rich TUI frameworks that don't accept programmatic
   * \\r as submit in interactive PTY mode. The shell approach bypasses this by
   * executing `cli -p "prompt"` for each message, using -c/--resume for context.
   */
  type SessionMode = "interactive" | "shell";

  const autoSessionConfigs: Record<string, {
    cmd: string;
    args: string[];
    mode: SessionMode;
  }> = {
    claude: {
      cmd: IS_WINDOWS ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: IS_WINDOWS ? ["/d", "/s"] : [],
      mode: "shell",
    },
    codex: {
      cmd: IS_WINDOWS ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: IS_WINDOWS ? ["/d", "/s"] : [],
      mode: "shell",
    },
    gemini: {
      cmd: IS_WINDOWS ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: IS_WINDOWS ? ["/d", "/s"] : [],
      mode: "shell",
    },
  };

  /** Track how many prompts have been sent to each shell-based session (for -c / --resume) */
  const shellPromptCount = new Map<string, number>();

  /** Build the CLI command string for a shell-based session */
  const buildCliCommand = (name: string, prompt: string, isFirst: boolean): string => {
    // Escape double quotes for cmd.exe (double them)
    const escaped = prompt.replace(/"/g, '""');

    if (name === "claude") {
      const continueFlag = isFirst ? "" : " -c";
      return `claude --dangerously-skip-permissions${continueFlag} -p "${escaped}"`;
    } else if (name === "codex") {
      return `codex --full-auto "${escaped}"`;
    } else if (name === "gemini") {
      const resumeFlag = isFirst ? "" : " --resume latest";
      return `gemini --yolo${resumeFlag} -p "${escaped}"`;
    }
    return prompt;
  };

  /** Resolve CLI name from session ID */
  const getCliName = (id: string): string | null => {
    if (id.startsWith("claude-")) return "claude";
    if (id.startsWith("gemini-")) return "gemini";
    if (id.startsWith("codex-")) return "codex";
    return null;
  };

  // ---- Load configuration ----
  const config = loadConfig();
  console.log(`[config] Loaded configuration (readyKeyword=${config.readyKeyword}, readyTimeoutMs=${config.readyTimeoutMs}ms, idleCompleteMs=${config.idleCompleteMs}ms, questionTimeoutMs=${config.questionTimeoutMs}ms)`);

  // ---- Session readiness probe (from config) ----
  const READY_KEYWORD = config.readyKeyword;
  const READY_PROBE_PROMPT = config.readyProbePrompt;
  const READY_TIMEOUT_MS = config.readyTimeoutMs;

  // ---- Workflow pipeline constants (from config) ----
  const QUESTION_TIMEOUT_MS = config.questionTimeoutMs;
  const DISCUSSION_TIMEOUT_MS = config.questionTimeoutMs;
  const DISCUSSION_TURN_TIMEOUT_MS = config.discussionTurnTimeoutMs;
  const IDLE_COMPLETE_MS = config.idleCompleteMs;

  /** Strip ANSI escape sequences from text */
  const stripAnsi = (text: string): string =>
    text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")       // OSC sequences
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")   // DEC private modes
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // control chars (keep \n \r \t)

  /** Environment overrides to discourage TUI rendering in subprocesses */
  const subprocessEnv = {
    ...process.env,
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "true",
    FORCE_COLOR: "0",
  };

  /** Save stderr output to workspace for debugging */
  const saveStderrLog = (cli: CliNameKey, phase: string, stderr: string) => {
    if (!workspacePath || !stderr || stderr.trim().length === 0) return;
    try {
      const logFile = path.join(workspacePath, cli, `${phase}_stderr.log`);
      fs.writeFileSync(logFile, stderr, "utf8");
      console.log(`[debug] ${cli}: saved stderr to ${phase}_stderr.log (${stderr.length} bytes)`);
    } catch (e) {
      console.warn(`[debug] ${cli}: failed to save stderr log:`, e);
    }
  };

  /**
   * Parse Codex JSONL output (from `codex exec --json`) and extract text content.
   *
   * Actual Codex v0.39+ `exec --json` event format (nested msg structure):
   *   {"model":"...","sandbox":"...","provider":"..."}          // config
   *   {"prompt":"..."}                                          // prompt echo
   *   {"id":"0","msg":{"type":"task_started",...}}              // task start
   *   {"id":"0","msg":{"type":"agent_reasoning","text":"..."}}  // reasoning
   *   {"id":"0","msg":{"type":"message_output_text","text":"..."}}  // CONTENT
   *   {"id":"0","msg":{"type":"task_complete","last_agent_message":"..."}}  // final
   */
  const parseCodexJsonl = (rawOutput: string): string => {
    const lines = rawOutput.split("\n");
    const textParts: string[] = [];
    let lastAgentMessage = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      try {
        const event = JSON.parse(trimmed);
        const msg = event.msg;

        if (msg && typeof msg === "object") {
          // agent_message — full assistant response text
          if (msg.type === "agent_message" && msg.message) {
            textParts.push(msg.message);
            continue;
          }

          // message_output_text — streaming content chunks (alternative format)
          if (msg.type === "message_output_text" && msg.text) {
            textParts.push(msg.text);
            continue;
          }

          // task_complete — final event, may contain full message
          if (msg.type === "task_complete" && msg.last_agent_message) {
            lastAgentMessage = msg.last_agent_message;
            continue;
          }
        }
      } catch {
        // Not valid JSON — skip
      }
    }

    // Prefer streamed text parts; fall back to last_agent_message from task_complete
    if (textParts.length > 0) {
      return textParts.join("").trim();
    }
    if (lastAgentMessage) {
      return lastAgentMessage.trim();
    }

    // Fallback: return non-JSON lines stripped of ANSI
    return lines
      .filter(l => l.trim() && !l.trim().startsWith("{"))
      .map(l => stripAnsi(l))
      .join("\n")
      .trim();
  };

  /**
   * Parse Claude stream-json output (from `--output-format stream-json`).
   * Claude outputs JSONL events; we extract text from assistant message events.
   *
   * Event types:
   *   {"type":"system","subtype":"init","session_id":"...","model":"..."}
   *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
   *   {"type":"result","subtype":"success","cost_usd":...,"usage":{...}}
   */
  const parseClaudeStreamJson = (rawOutput: string): string => {
    const lines = rawOutput.split("\n");
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      try {
        const event = JSON.parse(trimmed);

        // assistant event with message.content array
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "thinking" && block.thinking) {
              thinkingParts.push(block.thinking);
            }
          }
          continue;
        }

        // result event — final, skip (contains usage info only)
        if (event.type === "result") continue;
        // system event — init, skip
        if (event.type === "system") continue;
      } catch {
        // Not valid JSON — skip
      }
    }

    // Prefer text blocks; fall back to thinking blocks if no text was emitted
    // (e.g., process was killed during extended thinking before text generation)
    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
    if (thinkingParts.length > 0) {
      console.warn(`[parseClaudeStreamJson] No text blocks found, falling back to thinking content (${thinkingParts.length} blocks)`);
      return thinkingParts.join("\n").trim();
    }

    // Fallback: return non-JSON lines stripped of ANSI
    return lines
      .filter(l => l.trim() && !l.trim().startsWith("{"))
      .map(l => stripAnsi(l))
      .join("\n")
      .trim();
  };

  /**
   * Parse Gemini stream-json output (from `--output-format stream-json`).
   * Gemini outputs JSONL events; we extract text from assistant message events.
   *
   * Event types:
   *   {"type":"init","session_id":"...","model":"..."}
   *   {"type":"message","role":"assistant","content":"...","delta":true}
   *   {"type":"tool_use","tool_name":"...","parameters":{...}}
   *   {"type":"tool_result","tool_id":"...","status":"success","output":"..."}
   *   {"type":"result","status":"success","stats":{...}}
   */
  const parseGeminiStreamJson = (rawOutput: string): string => {
    const lines = rawOutput.split("\n");
    const textParts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      try {
        const event = JSON.parse(trimmed);

        // message event from assistant with text content
        if (event.type === "message" && event.role === "assistant" && event.content) {
          if (typeof event.content === "string") {
            textParts.push(event.content);
          } else if (Array.isArray(event.content)) {
            for (const part of event.content) {
              if (typeof part === "string") {
                textParts.push(part);
              } else if (part.text) {
                textParts.push(part.text);
              }
            }
          }
          continue;
        }

        // result/init/tool events — skip
        if (event.type === "result" || event.type === "init" || event.type === "tool_use" || event.type === "tool_result") continue;
      } catch {
        // Not valid JSON — skip
      }
    }

    if (textParts.length > 0) {
      return textParts.join("").trim();  // join without separator for deltas
    }

    // Fallback: return non-JSON lines stripped of ANSI
    return lines
      .filter(l => l.trim() && !l.trim().startsWith("{"))
      .map(l => stripAnsi(l))
      .join("\n")
      .trim();
  };

  /** Validate output quality — returns null if valid, or an error reason string */
  const validateOutput = (cli: CliNameKey, clean: string, phase: string): string | null => {
    if (clean.length === 0) {
      return `${cli} ${phase}: empty output (0 chars)`;
    }
    if (clean.length < 20) {
      return `${cli} ${phase}: suspiciously short output (${clean.length} chars)`;
    }
    // Check ratio of printable text characters
    const textChars = clean.replace(/[^\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef.,;:!?，。；：！？、·\-—()（）[\]【】{}""''\"'`]/g, "").length;
    const ratio = textChars / clean.length;
    if (ratio < 0.5) {
      return `${cli} ${phase}: high ratio of non-text characters (${(ratio * 100).toFixed(0)}% text)`;
    }
    return null;
  };

  type ReadyState = "pending" | "checking" | "ready" | "failed";
  type CliNameKey = "claude" | "codex" | "gemini";
  const CLI_NAMES: CliNameKey[] = ["claude", "codex", "gemini"];

  // ---- Workflow pipeline state ----
  type QuestionState = "pending" | "sending" | "answering" | "done" | "failed";
  const questionStates: Record<CliNameKey, QuestionState> = { claude: "pending", codex: "pending", gemini: "pending" };
  let workspacePath: string | null = null;
  let discussionFilePath: string | null = null;
  let planFilePath: string | null = null;
  let pendingUserInputResolve: ((answers: Record<number, string>) => void) | null = null;

  // ---- Discussion state model ----
  interface DiscussionEntry {
    cli: CliNameKey;
    state: "pending" | "responding" | "done" | "failed";
    cleanOutput: string;
    error?: string;
  }

  interface DiscussionRound {
    roundNumber: number;
    speakers: CliNameKey[];
    entries: Record<string, DiscussionEntry>;
    startedAt: string;
    completedAt?: string;
  }

  interface DiscussionState {
    currentRound: number;
    maxRounds: number;
    status: "pending" | "running" | "completed" | "failed";
    rounds: DiscussionRound[];
    participants: CliNameKey[];
    discussionFilePath: string | null;
  }

  let discussionState: DiscussionState | null = null;

  /** Rotate speakers for each round */
  const rotateSpeakers = (participants: CliNameKey[], round: number): CliNameKey[] => {
    const offset = (round - 1) % participants.length;
    return [...participants.slice(offset), ...participants.slice(0, offset)];
  };

  /**
   * Reusable CLI subprocess executor.
   * Spawns a CLI subprocess, waits for completion via idle-timeout or process exit.
   * Returns { raw, clean, stderr, exitCode } output.
   */
  const executeCliSubprocess = (
    cli: CliNameKey,
    prompt: string,
    opts: { cwd: string; idleMs: number; hardTimeoutMs: number; env: NodeJS.ProcessEnv; model?: string }
  ): Promise<{ raw: string; clean: string; stderr: string; exitCode: number | null }> => {
    return new Promise((resolve, reject) => {
      // Build command and args per CLI (following Any-Code reference patterns).
      // All CLIs use stdin for prompt delivery to avoid Windows cmd.exe issues
      // (newline truncation, ~8KB arg limit, escaping problems).
      // All CLIs output structured JSONL for reliable parsing.
      let cmd: string;
      let args: string[];

      if (cli === "claude") {
        // Claude: stdin pipe + stream-json output (following Any-Code pattern)
        cmd = "claude";
        args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
        if (opts.model) args.push("--model", opts.model);
      } else if (cli === "codex") {
        // Codex: `exec --json` outputs structured JSONL (no TUI garbage)
        //        `--full-auto` auto-approves all actions
        //        `-` reads prompt from stdin (avoids cmd.exe escaping/length issues)
        cmd = "codex";
        args = ["exec", "--json", "--full-auto", "--skip-git-repo-check", "-"];
      } else {
        // Gemini: stdin pipe + stream-json output (following Any-Code pattern)
        cmd = "gemini";
        args = ["--yolo", "--output-format", "stream-json"];
      }

      console.log(`[exec] ${cli}: spawning: ${cmd} ${args.join(" ")} (prompt via stdin)`);

      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        shell: true, // required on Windows to resolve .cmd wrappers (npm global installs)
        stdio: ["pipe", "pipe", "pipe"],
        env: opts.env,
      });

      // All CLIs: write prompt via stdin then signal EOF (following Any-Code pattern)
      child.stdin?.write(prompt);
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let hasStdout = false;
      let hasContent = false; // true once actual response content is detected (not just init/meta events)
      let exitCode: number | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      // Detect whether stdout contains actual response content (not just init/meta events).
      // Uses fast string matching — no JSON parsing needed.
      const checkForContent = (): boolean => {
        if (cli === "claude") {
          // Must detect actual text content blocks, NOT thinking events.
          // Claude outputs {"type":"assistant","message":{"content":[{"type":"thinking",...}]}}
          // before the text block. The idle timer must NOT start during the thinking phase.
          return stdout.includes('"type":"text","text"');
        } else if (cli === "codex") {
          return stdout.includes('"type":"agent_message"') || stdout.includes('"type":"message_output_text"') || stdout.includes('"type":"task_complete"');
        } else {
          // Gemini: look for assistant messages (not user echo)
          return stdout.includes('"role":"assistant"');
        }
      };

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          settle("done", `idle timeout (no stdout for ${opts.idleMs / 1000}s)`);
          try { child.kill(); } catch {}
        }, opts.idleMs);
      };

      const settle = (state: "done" | "failed", reason: string) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);

        // All CLIs output structured JSONL; parse with CLI-specific parser
        const cleanStdout = cli === "codex"
          ? parseCodexJsonl(stdout)
          : cli === "claude"
            ? parseClaudeStreamJson(stdout)
            : parseGeminiStreamJson(stdout);
        console.log(`[exec] ${cli}: ${state === "done" ? "✓" : "✗"} ${reason} (stdout=${stdout.length}, clean=${cleanStdout.length}, stderr=${stderr.length})`);

        // Debug: when stdout exists but parser returned empty, dump raw stdout for diagnosis
        if (stdout.length > 0 && cleanStdout.length === 0) {
          console.warn(`[exec] ${cli}: ⚠ JSONL parser returned empty! Raw stdout (first 500 chars):\n${stdout.substring(0, 500)}`);
          if (workspacePath) {
            try {
              const rawFile = path.join(workspacePath, cli, `raw_stdout_debug.txt`);
              fs.writeFileSync(rawFile, stdout, "utf8");
              console.log(`[exec] ${cli}: saved raw stdout to raw_stdout_debug.txt`);
            } catch {}
          }
        }

        if (state === "done") {
          resolve({ raw: stdout, clean: cleanStdout, stderr, exitCode });
        } else {
          const err = new Error(reason) as Error & { stderr: string; exitCode: number | null };
          err.stderr = stderr;
          err.exitCode = exitCode;
          reject(err);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!hasStdout) {
          hasStdout = true;
          console.log(`[exec] ${cli}: first stdout received`);
        }

        // Only start idle timer once actual content events arrive.
        // Init/meta events arrive immediately but the LLM may take 30-60s+ to
        // start producing response tokens. We don't want to time out during thinking.
        if (!hasContent) {
          hasContent = checkForContent();
          if (hasContent) {
            console.log(`[exec] ${cli}: response content detected, starting idle timer`);
          }
        }
        if (hasContent) {
          resetIdleTimer();
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        console.log(`[exec] ${cli}: stderr chunk (${chunk.length} bytes)`);
      });

      child.on("close", (code) => {
        exitCode = code;
        if (code != null && code !== 0 && stdout.length === 0) {
          // Definite failure: non-zero exit with no stdout
          settle("failed", `process exited with error (code=${code})`);
        } else if (code != null && code !== 0) {
          // Partial success: non-zero exit but we got some stdout
          console.warn(`[exec] ${cli}: ⚠ non-zero exit (code=${code}) but got ${stdout.length} bytes stdout — treating as partial success`);
          settle("done", `process exited (code=${code}, partial success)`);
        } else {
          // Normal success
          settle("done", `process exited (code=${code})`);
        }
      });

      child.on("error", (err) => {
        settle("failed", `spawn error: ${err.message}`);
      });

      const hardTimer = setTimeout(() => {
        try { child.kill(); } catch {}
        settle("failed", `hard timeout (${opts.hardTimeoutMs / 1000}s)`);
      }, opts.hardTimeoutMs);
    });
  };

  const sessionReadyState: Record<CliNameKey, ReadyState> = {
    claude: "pending",
    codex: "pending",
    gemini: "pending",
  };
  const sessionReadyError: Record<CliNameKey, string | null> = {
    claude: null,
    codex: null,
    gemini: null,
  };

  /** Broadcast readiness update for a single CLI */
  const broadcastReadyState = (cli: CliNameKey) => {
    broadcastAll("cli.ready", {
      cli,
      state: sessionReadyState[cli],
      error: sessionReadyError[cli],
    });
  };

  /** Check if all CLIs are ready and broadcast allReady if so */
  const checkAllReady = () => {
    const allReady = CLI_NAMES.every((c) => sessionReadyState[c] === "ready");
    const allDone = CLI_NAMES.every(
      (c) => sessionReadyState[c] === "ready" || sessionReadyState[c] === "failed"
    );
    if (allDone) {
      broadcastAll("cli.allReady", {
        allReady,
        states: { ...sessionReadyState },
        errors: { ...sessionReadyError },
      });
      if (allReady) {
        console.log(`[ready] ✓ All CLIs are ready`);
        // ---- Trigger workflow pipeline if initialQuestion is set ----
        if (initialQuestion) {
          startWorkflowPipeline();
        }
      } else {
        const failed = CLI_NAMES.filter((c) => sessionReadyState[c] === "failed");
        console.log(`[ready] ✗ Some CLIs failed: ${failed.join(", ")}`);
      }
    }
  };

  // ---- Workflow pipeline functions ----

  /** Create workspace directory structure */
  const createWorkspace = (): string => {
    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + "_"
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0")
      + String(now.getSeconds()).padStart(2, "0");

    const wsDir = path.join(projectPath, ".ultraplan", `workspace_${ts}`);
    for (const cli of CLI_NAMES) {
      fs.mkdirSync(path.join(wsDir, cli), { recursive: true });
    }

    // Write discussion template from config to workspace root
    const templateDst = path.join(wsDir, "ExpertReviewTemplate_v5.md");
    try {
      fs.writeFileSync(templateDst, config.discussionTemplate, "utf8");
      console.log(`[workspace] Template written to ${templateDst}`);
    } catch (e) {
      console.warn(`[workspace] Failed to write template:`, e);
    }

    console.log(`[workspace] Created: ${wsDir}`);
    return wsDir;
  };

  /**
   * Send initial question to all ready CLIs using independent subprocesses.
   * Uses executeCliSubprocess for spawning.
   */
  const sendInitialQuestion = (question: string) => {
    broadcastAll("ultraplan.initialQuestion", { question });

    // Construct the effective prompt: wrap with planning-mode instructions
    const planningInstructions = [
      `You are a senior technical expert.`,
      `Please provide your independent professional analysis and recommendations for the following question.`,
      ``,
      `Requirements:`,
      `- This is a planning and discussion phase — do NOT write any code or create any files`,
      `- Provide your technical analysis, architecture suggestions, and technology recommendations`,
      `- Analyze pros, cons, and potential risks`,
      `- Give concrete implementation suggestions and steps`,
      `- Write your response in ${config.discussionLanguage}`,
    ].join("\n");

    let effectiveQuestion = `${planningInstructions}\n\n[Question]\n${question}`;
    if (config.systemPrompt.trim()) {
      effectiveQuestion = `[System Instructions]\n${config.systemPrompt.trim()}\n\n${planningInstructions}\n\n[Question]\n${question}`;
      console.log(`[question] System prompt injected (${config.systemPrompt.length} chars)`);
    }

    for (const cli of CLI_NAMES) {
      if (sessionReadyState[cli] !== "ready") {
        questionStates[cli] = "failed";
        broadcastAll("ultraplan.questionComplete", { cli, state: "failed" });
        checkAllQuestionsComplete();
        continue;
      }

      questionStates[cli] = "answering";
      broadcastAll("ultraplan.questionComplete", { cli, state: "answering" });

      executeCliSubprocess(cli, effectiveQuestion, {
        cwd: projectPath,
        idleMs: IDLE_COMPLETE_MS,
        hardTimeoutMs: QUESTION_TIMEOUT_MS,
        env: subprocessEnv,
      }).then(({ clean, stderr }) => {
        // Save stderr for debugging
        saveStderrLog(cli, "initial_answer", stderr);

        // Validate output quality
        const validationError = validateOutput(cli, clean, "initial_answer");
        if (validationError) {
          console.warn(`[question] ${cli}: ⚠ output validation failed: ${validationError}`);
          questionStates[cli] = "failed";
          broadcastAll("ultraplan.questionComplete", { cli, state: "failed", error: validationError });
          checkAllQuestionsComplete();
          return;
        }

        questionStates[cli] = "done";

        // Save output to workspace
        if (workspacePath && clean.length > 0) {
          const outputFile = path.join(workspacePath, cli, "initial_answer.md");
          try {
            fs.writeFileSync(outputFile, clean, "utf8");
            console.log(`[question] ${cli}: saved answer (${clean.length} chars)`);
          } catch (e) {
            console.warn(`[question] ${cli}: failed to save answer:`, e);
          }
        }

        console.log(`[question] ${cli}: ✓ done`);
        broadcastAll("ultraplan.questionComplete", { cli, state: "done" });
        checkAllQuestionsComplete();
      }).catch((err: any) => {
        // Save stderr from error for debugging
        if (err.stderr) saveStderrLog(cli, "initial_answer", err.stderr);
        questionStates[cli] = "failed";
        console.log(`[question] ${cli}: ✗ ${err.message}`);
        broadcastAll("ultraplan.questionComplete", { cli, state: "failed" });
        checkAllQuestionsComplete();
      });
    }
  };

  /** Check if all questions are answered (with double-call guard) */
  let allQuestionsHandled = false;
  const checkAllQuestionsComplete = () => {
    if (allQuestionsHandled) return;

    const allDone = CLI_NAMES.every(
      (c) => questionStates[c] === "done" || questionStates[c] === "failed"
    );
    if (!allDone) return;

    allQuestionsHandled = true;

    const doneCount = CLI_NAMES.filter((c) => questionStates[c] === "done").length;
    broadcastAll("ultraplan.allQuestionsComplete", { states: { ...questionStates } });
    console.log(`[question] All questions complete (${doneCount}/${CLI_NAMES.length} succeeded):`, { ...questionStates });

    // Proceed if at least one CLI succeeded (no longer requires specific CLI)
    if (doneCount === 0) {
      console.log(`[question] No CLIs succeeded — skipping discussion file initialization`);
      broadcastAll("ultraplan.discussionFileInit", { status: "skipped", error: "All CLIs failed" });
      return;
    }

    initializeDiscussionFile();
  };

  /**
   * Initialize discussion file from template (server-side string replacement).
   * No CLI subprocess needed — just read template, fill Section 1, write file.
   */
  const initializeDiscussionFile = () => {
    if (!workspacePath) return;

    broadcastAll("ultraplan.discussionFileInit", { status: "starting" });
    console.log(`[discussion] Initializing discussion file (server-side)...`);

    const topicName = "Discussion";
    const wsPathFwd = workspacePath.replace(/\\/g, "/");
    const outputPath = `${wsPathFwd}/${topicName}_Review.md`;
    discussionFilePath = outputPath;

    try {
      // Read template from config
      let content = config.discussionTemplate;

      // Fill in Section 1: Topic Overview
      const today = new Date().toISOString().split("T")[0];
      content = content.replace(
        /\[Brief description of the core discussion topic\]/,
        initialQuestion ?? "No topic specified"
      );
      content = content.replace(/\[YYYY-MM-DD\]/, today);
      content = content.replace(
        /\[List of participating experts\/roles\]/,
        "Claude, Codex, Gemini"
      );
      content = content.replace(
        /\[Background description here\]/,
        "This discussion was initiated through Ultra Plan Mode to gather expert perspectives on the topic."
      );

      // Replace title placeholder
      content = content.replace(/\[TopicName\]/g, topicName);

      fs.writeFileSync(outputPath, content, "utf8");
      console.log(`[discussion] discussion file created at ${outputPath}`);
      broadcastAll("ultraplan.discussionFileCreated", { path: outputPath, topicName });

      // Auto-trigger discussion rounds
      startDiscussionRounds(outputPath);
    } catch (err: any) {
      console.error(`[discussion] failed to initialize discussion file: ${err.message}`);
      broadcastAll("ultraplan.discussionFileInit", { status: "failed", error: err.message });
    }
  };

  /**
   * Append content to the discussion file at a given section (programmatic string manipulation).
   * All CLIs are read-only; this is the sole mechanism for writing to the discussion file.
   *
   * @param heading - The heading to use (e.g. "### Expert: Codex" or "### Discussion Round 1: Codex").
   *                  If content already starts with "###", used as-is without prepending heading.
   */
  const appendToDiscussionFileDirect = (filePath: string, sectionMarker: string, heading: string, content: string) => {
    // Guard: reject empty or garbage content
    if (!content || content.trim().length < 20) {
      console.warn(`[discussion] Skipping append for ${heading}: content too short (${content?.length ?? 0} chars)`);
      return;
    }

    // If content already starts with a heading, use as-is; otherwise prepend the heading
    const normalizedContent = content.trimStart().startsWith("###")
      ? content.trim()
      : `${heading}\n\n${content.trim()}`;

    try {
      let fileContent = fs.readFileSync(filePath, "utf8");
      const sectionIdx = fileContent.indexOf(sectionMarker);
      if (sectionIdx === -1) {
        fileContent += `\n\n${normalizedContent}\n`;
      } else {
        const afterSection = fileContent.indexOf("\n## ", sectionIdx + sectionMarker.length);
        const insertPos = afterSection === -1 ? fileContent.length : afterSection;
        fileContent = fileContent.slice(0, insertPos) +
          `\n\n${normalizedContent}\n` +
          fileContent.slice(insertPos);
      }
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log(`[discussion] Appended to ${sectionMarker}: ${heading} (${content.length} chars)`);
    } catch (e) {
      console.warn(`[discussion] Failed to append to discussion file:`, e);
    }
  };

  /** Save discussion state to disk */
  const saveDiscussionState = () => {
    if (!workspacePath || !discussionState) return;
    try {
      const statePath = path.join(workspacePath, "discussion_state.json");
      fs.writeFileSync(statePath, JSON.stringify(discussionState, null, 2), "utf8");
    } catch (e) {
      console.warn(`[discussion] Failed to save discussion state:`, e);
    }
  };

  /**
   * Build read-only discussion prompts for all CLIs.
   * File content is included inline — CLIs output text only, never edit files.
   */
  const buildDiscussionPrompt = (
    cli: CliNameKey,
    discFilePath: string,
    phase: "initial_view" | "discussion",
    round?: number
  ): string => {
    const cliCapName = cli.charAt(0).toUpperCase() + cli.slice(1);

    // Read current discussion file content and include inline
    let fileContent = "";
    try {
      fileContent = fs.readFileSync(discFilePath, "utf8");
      // Truncate at 50K chars to stay within prompt limits
      if (fileContent.length > 50_000) {
        fileContent = fileContent.substring(0, 50_000) + "\n\n... [truncated at 50K chars] ...";
      }
    } catch (e) {
      console.warn(`[discussion] Failed to read discussion file for prompt: ${e}`);
      fileContent = "(Discussion file could not be read)";
    }

    if (phase === "initial_view") {
      return [
        `You are an expert participating in a structured discussion.`,
        `Below is the current discussion file content:`,
        ``,
        `---FILE START---`,
        fileContent,
        `---FILE END---`,
        ``,
        `Please provide your initial perspective on the topic described in Section 1.`,
        `Write your response in ${config.discussionLanguage}.`,
        `Output ONLY your contribution text — do NOT attempt to edit any files.`,
        ``,
        `Requirements:`,
        `- Your initial perspective forms the basis for subsequent discussion; be thorough and detailed.`,
        `- Generate your own unique insights based on the topic.`,
        `- Do not respond to or reference other experts' perspectives (think independently).`,
        ``,
        `Format: Output your analysis directly. Do NOT prefix your response with "Expert: ${cliCapName}" — this label is added automatically by the system.`,
        `Do NOT use heading-level markdown (# ## ###) in your response. Use bold text (**Section Name**:) for section titles instead.`,
      ].join("\n");
    }

    // phase === "discussion"
    const isFirstRound = round === 1;
    const focusInstructions = isFirstRound
      ? [
          `Focus on: points of agreement, disagreements with other experts, new insights, and directions for further exploration.`,
          `When you need a response from another expert, mention them with @ExpertName.`,
          `Appropriately defend your reasonable viewpoints.`,
        ].join("\n")
      : [
          `Focus on: responding to @mentions directed at you, evolving points of agreement/disagreement, and building toward consensus.`,
          `When you need a response from another expert, mention them with @ExpertName.`,
        ].join("\n");

    return [
      `You are an expert participating in a structured discussion (Round ${round ?? ""}).`,
      `Below is the current discussion file content:`,
      ``,
      `---FILE START---`,
      fileContent,
      `---FILE END---`,
      ``,
      `Read all existing perspectives and discussion entries.`,
      `Provide your discussion contribution for Round ${round ?? ""}.`,
      `Write your response in ${config.discussionLanguage}.`,
      `Output ONLY your contribution text — do NOT attempt to edit any files.`,
      ``,
      focusInstructions,
      ``,
      `Format: Output your discussion content directly. Do NOT prefix your response with "Discussion Round ${round ?? ""}: ${cliCapName}" — this label is added automatically by the system.`,
    ].join("\n");
  };

  /**
   * Analyze the discussion file with Claude Haiku to determine if user input is needed.
   * Returns questions to ask, or empty if no input needed.
   */
  const analyzeForUserInput = async (
    discFilePath: string,
    round: number
  ): Promise<{ needsInput: boolean; questions: string[] }> => {
    const fileContent = fs.readFileSync(discFilePath, "utf8");
    const prompt = `You are analyzing an expert discussion document. Determine if there are critical information gaps that would significantly improve the next round of discussion if clarified by the user (developer/requester).

Only ask if missing information would MEANINGFULLY change expert recommendations. Focus on: developer experience level, specific technical constraints, existing tech stack choices, performance requirements, or other context-specific factors NOT mentioned in the discussion.

Maximum 3 questions. Be concise and specific.

Discussion document:
${fileContent}

Return ONLY valid JSON:
{"needsInput": false}
OR
{"needsInput": true, "questions": ["Question 1?", "Question 2?"]}`;

    try {
      const { clean } = await executeCliSubprocess("claude", prompt, {
        cwd: projectPath,
        idleMs: 20000,
        hardTimeoutMs: 90000,
        env: subprocessEnv,
        model: "claude-haiku-4-5",
      });
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          needsInput: parsed.needsInput === true,
          questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
        };
      }
    } catch (err) {
      console.warn(`[userInput] Round ${round}: haiku analysis failed:`, err);
    }
    return { needsInput: false, questions: [] };
  };

  /**
   * Analyze the discussion file with Claude Haiku to decide if another round is needed.
   */
  const analyzeForContinuation = async (
    discFilePath: string,
    round: number,
    maxRounds: number
  ): Promise<{ shouldContinue: boolean; reason: string }> => {
    const fileContent = fs.readFileSync(discFilePath, "utf8");
    const prompt = `You are evaluating a multi-round expert discussion (currently after round ${round}, max allowed: ${maxRounds}).

Decide if another discussion round is needed.
Continue if: experts still have significant disagreements, important perspectives are unexplored, or key questions remain unresolved.
Stop if: consensus is forming, core issues have been covered, or more rounds would be repetitive.

Discussion document:
${fileContent}

Return ONLY valid JSON:
{"shouldContinue": false, "reason": "Core issues covered, consensus forming"}
OR
{"shouldContinue": true, "reason": "Significant disagreement on X remains unresolved"}`;

    try {
      const { clean } = await executeCliSubprocess("claude", prompt, {
        cwd: projectPath,
        idleMs: 20000,
        hardTimeoutMs: 90000,
        env: subprocessEnv,
        model: "claude-haiku-4-5",
      });
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          shouldContinue: parsed.shouldContinue === true,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        };
      }
    } catch (err) {
      console.warn(`[continuation] Round ${round}: haiku analysis failed:`, err);
    }
    return { shouldContinue: false, reason: "Analysis failed — stopping" };
  };

  /** Pause workflow and wait for user to submit answers via WebSocket. */
  const pauseForUserInput = (round: number, questions: string[]): Promise<Record<number, string>> => {
    return new Promise((resolve) => {
      pendingUserInputResolve = resolve;
      broadcastAll("ultraplan.userInputNeeded", { round, questions });
      console.log(`[userInput] Round ${round}: pausing workflow, waiting for user input...`);
    });
  };

  /** Append user Q&A to the discussion file under Section 3. */
  const appendUserInputToDiscussion = (
    discFilePath: string,
    round: number,
    questions: string[],
    answers: Record<number, string>
  ) => {
    const lines: string[] = [`### User Clarifications (After Round ${round})\n`];
    questions.forEach((q, i) => {
      const a = answers[i]?.trim() || "(no answer)";
      lines.push(`**Q${i + 1}: ${q}**\nA: ${a}\n`);
    });
    const content = lines.join("\n");
    appendToDiscussionFileDirect(discFilePath, "## 3.", `### User Clarifications (After Round ${round})`, content);
    console.log(`[userInput] Round ${round}: appended ${questions.length} Q&A to discussion file`);
    try { broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") }); } catch {}
  };

  /**
   * Main discussion orchestration: startDiscussionRounds
   *
   * Phase A: Supplement initial views (Claude + Codex add views to Section 2)
   * Phase B: Multi-round discussion (sequential speakers per round)
   * Phase C: Consensus summary (by Gemini)
   */
  const startDiscussionRounds = async (discFilePath: string) => {
    // Determine participants: only CLIs that succeeded in initial question
    const participants = CLI_NAMES.filter((c) => questionStates[c] === "done");
    if (participants.length < 2) {
      console.log(`[discussion] Only ${participants.length} participant(s) — skipping discussion`);
      broadcastAll("ultraplan.discussionComplete", { status: "skipped", totalRounds: 0 });
      return;
    }

    const maxRounds = config.discussionRounds;
    discussionState = {
      currentRound: 0,
      maxRounds,
      status: "running",
      rounds: [],
      participants,
      discussionFilePath: discFilePath,
    };

    // ==== Phase A: All participants provide initial views ====
    console.log(`[discussion] Phase A: collecting initial views from all participants...`);
    broadcastAll("ultraplan.initialViewStart", { participants });

    for (const cli of participants) {
      broadcastAll("ultraplan.initialViewUpdate", { cli, state: "responding" });

      const viewPrompt = buildDiscussionPrompt(cli, discFilePath, "initial_view");

      try {
        const { clean, stderr } = await executeCliSubprocess(cli, viewPrompt, {
          cwd: projectPath,
          idleMs: IDLE_COMPLETE_MS,
          hardTimeoutMs: DISCUSSION_TURN_TIMEOUT_MS,
          env: subprocessEnv,
        });

        saveStderrLog(cli, "initial_view", stderr);

        // Validate output (all CLIs return text via JSONL parsing)
        const validationError = validateOutput(cli, clean, "initial_view");
        if (validationError) {
          console.warn(`[discussion] ${cli}: initial view validation failed: ${validationError}`);
          broadcastAll("ultraplan.initialViewUpdate", { cli, state: "failed", error: validationError });
          continue;
        }

        // Append CLI's text output to Section 2 (CLIs are read-only, they never edit files)
        if (clean.length > 0) {
          const cliCapName = cli.charAt(0).toUpperCase() + cli.slice(1);
          const heading = `### Expert: ${cliCapName}`;
          appendToDiscussionFileDirect(discFilePath, "## 2.", heading, clean);
          console.log(`[discussion] ${cli}: appended initial view to discussion file`);
          try { broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") }); } catch {}
        }

        // Save individual response
        if (workspacePath) {
          const respFile = path.join(workspacePath, cli, "initial_view.md");
          try { fs.writeFileSync(respFile, clean, "utf8"); } catch {}
        }

        broadcastAll("ultraplan.initialViewUpdate", { cli, state: "done" });
        console.log(`[discussion] ${cli}: initial view done (${clean.length} chars)`);
      } catch (err: any) {
        if (err.stderr) saveStderrLog(cli, "initial_view", err.stderr);
        broadcastAll("ultraplan.initialViewUpdate", { cli, state: "failed" });
        console.log(`[discussion] ${cli}: initial view failed — ${err.message}`);
      }
    }

    broadcastAll("ultraplan.initialViewComplete", {});
    console.log(`[discussion] Phase A complete`);

    // ==== Phase B: Discussion rounds ====
    console.log(`[discussion] Phase B: dynamic rounds (max ${maxRounds})...`);
    broadcastAll("ultraplan.discussionStart", { maxRounds, participants });

    let round = 0;
    let shouldContinue = true;

    while (shouldContinue && round < maxRounds) {
      round++;
      discussionState.currentRound = round;
      const speakers = rotateSpeakers(participants, round);

      const roundData: DiscussionRound = {
        roundNumber: round,
        speakers,
        entries: {},
        startedAt: new Date().toISOString(),
      };
      discussionState.rounds.push(roundData);

      // Backup discussion file before each round
      try {
        fs.copyFileSync(discFilePath, discFilePath + `.bak_round_${round}`);
      } catch {}

      broadcastAll("ultraplan.discussionRoundStart", { round, speakers });
      console.log(`[discussion] Round ${round} (max ${maxRounds}): speakers = ${speakers.join(" → ")}`);

      let roundFailCount = 0;

      for (const speaker of speakers) {
        const entry: DiscussionEntry = {
          cli: speaker,
          state: "responding",
          cleanOutput: "",
        };
        roundData.entries[speaker] = entry;
        broadcastAll("ultraplan.discussionEntryUpdate", { round, cli: speaker, state: "responding" });

        // Build CLI-specific prompt
        const discussPrompt = buildDiscussionPrompt(speaker, discFilePath, "discussion", round);

        try {
          const { clean, stderr } = await executeCliSubprocess(speaker, discussPrompt, {
            cwd: projectPath,
            idleMs: IDLE_COMPLETE_MS,
            hardTimeoutMs: DISCUSSION_TURN_TIMEOUT_MS,
            env: subprocessEnv,
          });

          saveStderrLog(speaker, `round_${round}`, stderr);

          // Validate output (for Codex, clean comes from JSONL parsing)
          const validationError = validateOutput(speaker, clean, `round_${round}`);
          if (validationError) {
            console.warn(`[discussion] Round ${round}: ${speaker} ⚠ validation failed: ${validationError}`);
            entry.state = "failed";
            entry.error = validationError;
            roundFailCount++;
            broadcastAll("ultraplan.discussionEntryUpdate", { round, cli: speaker, state: "failed", error: validationError });
            continue;
          }

          entry.state = "done";
          entry.cleanOutput = clean;

          // All CLIs are read-only — always append their text output to Section 3
          if (clean.length > 20) {
            const speakerCapName = speaker.charAt(0).toUpperCase() + speaker.slice(1);
            const roundHeading = `### Discussion Round ${round}: ${speakerCapName}`;
            appendToDiscussionFileDirect(discFilePath, "## 3.", roundHeading, clean);
            console.log(`[discussion] Round ${round}: ${speaker}: appended to discussion file`);
            try { broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") }); } catch {}
          }

          // Save individual round response
          if (workspacePath) {
            const respFile = path.join(workspacePath, speaker, `round_${round}_response.md`);
            try { fs.writeFileSync(respFile, clean, "utf8"); } catch {}
          }

          broadcastAll("ultraplan.discussionEntryUpdate", { round, cli: speaker, state: "done" });
          console.log(`[discussion] Round ${round}: ${speaker} done (${clean.length} chars)`);
        } catch (err: any) {
          if (err.stderr) saveStderrLog(speaker, `round_${round}`, err.stderr);
          entry.state = "failed";
          entry.error = err.message;
          roundFailCount++;

          broadcastAll("ultraplan.discussionEntryUpdate", { round, cli: speaker, state: "failed", error: err.message });
          console.log(`[discussion] Round ${round}: ${speaker} failed — ${err.message}`);
        }
      }

      roundData.completedAt = new Date().toISOString();
      broadcastAll("ultraplan.discussionRoundComplete", { round });
      saveDiscussionState();

      // If all speakers failed this round, mark discussion as failed
      if (roundFailCount === speakers.length) {
        discussionState.status = "failed";
        broadcastAll("ultraplan.discussionComplete", { status: "failed", totalRounds: round });
        console.log(`[discussion] All speakers failed in round ${round} — aborting`);
        saveDiscussionState();
        return;
      }

      // Stop if cap reached
      if (round >= maxRounds) {
        broadcastAll("ultraplan.continuationDecision", { round, shouldContinue: false, reason: "已达最大轮次上限" });
        break;
      }

      // AI continuation analysis
      broadcastAll("ultraplan.continuationAnalyzing", { round });
      const contAnalysis = await analyzeForContinuation(discFilePath, round, maxRounds);
      broadcastAll("ultraplan.continuationDecision", {
        round,
        shouldContinue: contAnalysis.shouldContinue,
        reason: contAnalysis.reason,
      });
      console.log(`[discussion] Round ${round}: AI continuation = ${contAnalysis.shouldContinue} (${contAnalysis.reason})`);
      shouldContinue = contAnalysis.shouldContinue;

      // User input analysis only if continuing to next round
      if (shouldContinue) {
        broadcastAll("ultraplan.userInputAnalyzing", { round });
        try {
          const analysis = await analyzeForUserInput(discFilePath, round);
          if (analysis.needsInput && analysis.questions.length > 0) {
            const answers = await pauseForUserInput(round, analysis.questions);
            appendUserInputToDiscussion(discFilePath, round, analysis.questions, answers);
            broadcastAll("ultraplan.userInputReceived", {});
          }
        } catch (err) {
          console.warn(`[userInput] Round ${round}: analysis/input error:`, err);
        }
      }
    }

    const actualRounds = round;
    discussionState.status = "completed";
    broadcastAll("ultraplan.discussionComplete", { status: "completed", totalRounds: actualRounds });
    console.log(`[discussion] Phase B complete: ${actualRounds} round(s) done (max was ${maxRounds})`);
    saveDiscussionState();

    // ==== Phase C: Consensus summary ====
    if (config.enableConsensusSummary) {
      await generateConsensusSummary(discFilePath);
    }

    // ==== Phase D: Execution plan ====
    if (config.enablePlanGeneration) {
      await generateExecutionPlan(discFilePath);
    }

    // Always broadcast workflow complete
    broadcastAll("ultraplan.workflowComplete", {});
  };

  /** Generate consensus summary (read-only pattern: inline file content, text output only) */
  const generateConsensusSummary = async (discFilePath: string) => {
    console.log(`[discussion] Phase C: generating consensus summary...`);
    broadcastAll("ultraplan.consensusStart", {});

    // Pick the first available CLI for consensus (prefer gemini, then claude, then codex)
    const consensusCli = (["gemini", "claude", "codex"] as CliNameKey[]).find(
      (c) => questionStates[c] === "done"
    );
    if (!consensusCli) {
      console.error(`[discussion] No available CLI for consensus summary`);
      broadcastAll("ultraplan.consensusComplete", { status: "failed", error: "No available CLI" });
      return;
    }

    // Read discussion file content inline
    let fileContent = "";
    try {
      fileContent = fs.readFileSync(discFilePath, "utf8");
      if (fileContent.length > 50_000) {
        fileContent = fileContent.substring(0, 50_000) + "\n\n... [truncated at 50K chars] ...";
      }
    } catch (e) {
      console.warn(`[discussion] Failed to read discussion file for consensus: ${e}`);
    }

    const prompt = [
      `You are a discussion moderator tasked with writing a consensus summary.`,
      `Below is the full discussion file content:`,
      ``,
      `---FILE START---`,
      fileContent,
      `---FILE END---`,
      ``,
      `Please summarize the key consensus points, remaining disagreements, and actionable conclusions from this discussion.`,
      `Write your response in ${config.discussionLanguage}.`,
      `Output ONLY your summary text — do NOT attempt to edit any files.`,
      `Do NOT start with a meta-introduction sentence (e.g. "Here is the summary..."). Begin directly with the summary content.`,
      ``,
      `Format: Output your summary content directly. Do NOT prefix with "Consensus Summary" — it is added automatically.`,
      `Do NOT use heading-level markdown (# ## ###) in your response. Use bold text (**Section Name**:) for section titles instead.`,
    ].join("\n");

    try {
      const { clean, stderr } = await executeCliSubprocess(consensusCli, prompt, {
        cwd: projectPath,
        idleMs: IDLE_COMPLETE_MS,
        hardTimeoutMs: DISCUSSION_TURN_TIMEOUT_MS,
        env: subprocessEnv,
      });

      saveStderrLog(consensusCli, "consensus", stderr);

      // Append consensus to Section 4
      if (clean.length > 20) {
        appendToDiscussionFileDirect(discFilePath, "## 4.", `### Consensus Summary`, clean);
        try { broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") }); } catch {}
      }

      broadcastAll("ultraplan.consensusComplete", { status: "completed" });
      console.log(`[discussion] Consensus summary generated by ${consensusCli}`);
    } catch (err: any) {
      if (err.stderr) saveStderrLog(consensusCli, "consensus", err.stderr);
      broadcastAll("ultraplan.consensusComplete", { status: "failed", error: err.message });
      console.error(`[discussion] Consensus summary failed: ${err.message}`);
    }
  };

  /** Generate execution plan (Phase D): synthesize discussion into a standalone ExecutionPlan.md and Section 5. */
  const generateExecutionPlan = async (discFilePath: string) => {
    console.log(`[discussion] Phase D: generating execution plan...`);
    broadcastAll("ultraplan.planGenerationStart", {});

    // Pick best available CLI: Claude → Gemini → Codex (Claude preferred for structured planning)
    const planCli = (["claude", "gemini", "codex"] as CliNameKey[]).find(
      (c) => questionStates[c] === "done"
    );
    if (!planCli) {
      console.error(`[discussion] No available CLI for execution plan`);
      broadcastAll("ultraplan.planGenerationComplete", { status: "failed", error: "No available CLI" });
      return;
    }

    // Read discussion file content inline (capped at 60K chars)
    let fileContent = "";
    try {
      fileContent = fs.readFileSync(discFilePath, "utf8");
      if (fileContent.length > 60_000) {
        fileContent = fileContent.substring(0, 60_000) + "\n\n... [truncated at 60K chars] ...";
      }
    } catch (e) {
      console.warn(`[discussion] Failed to read discussion file for plan generation: ${e}`);
    }

    const prompt = [
      `You are creating a final execution plan based on the expert discussion below.`,
      ``,
      `Based on the expert discussion and consensus, generate a comprehensive, actionable execution plan document.`,
      ``,
      `Your plan MUST be structured with these sections:`,
      `- **Context**: The core problem or goal being addressed (from the discussion)`,
      `- **Recommended Approach**: The high-level strategy agreed upon and its rationale`,
      `- **Implementation Steps**: Numbered, concrete, actionable steps. For each step: what to do, which files or components to change (if applicable), specific technical details`,
      `- **Verification**: How to confirm the implementation is correct and complete`,
      `- **Risks and Considerations**: Key risks, caveats, and dependencies noted in the discussion`,
      ``,
      `Write in ${config.discussionLanguage}.`,
      `Output ONLY the plan content — do NOT edit any files.`,
      `Do NOT start with a meta-introduction. Begin directly with the plan content.`,
      `Do NOT use heading level 1 (#). Start from ## for main sections.`,
      ``,
      `Discussion content:`,
      `---FILE START---`,
      fileContent,
      `---FILE END---`,
    ].join("\n");

    try {
      const { clean, stderr } = await executeCliSubprocess(planCli, prompt, {
        cwd: projectPath,
        idleMs: IDLE_COMPLETE_MS,
        hardTimeoutMs: DISCUSSION_TURN_TIMEOUT_MS,
        env: subprocessEnv,
      });

      saveStderrLog(planCli, "execution_plan", stderr);

      // Write standalone ExecutionPlan.md (primary deliverable)
      if (workspacePath && clean.length > 20) {
        planFilePath = path.join(workspacePath, "ExecutionPlan.md");
        try {
          fs.writeFileSync(planFilePath, clean, "utf8");
          console.log(`[discussion] ExecutionPlan.md written to ${planFilePath} (${clean.length} chars)`);
        } catch (e) {
          console.warn(`[discussion] Failed to write ExecutionPlan.md:`, e);
          planFilePath = null;
        }
      }

      // Also append to Section 5 of the discussion file
      if (clean.length > 20) {
        appendToDiscussionFileDirect(discFilePath, "## 5.", `### Execution Plan`, clean);
        try {
          broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") });
          broadcastAll("ultraplan.planContent", { content: clean, filePath: planFilePath });
        } catch {}
      }

      broadcastAll("ultraplan.planGenerationComplete", { status: "completed", planFilePath });
      console.log(`[discussion] Execution plan generated by ${planCli}`);
    } catch (err: any) {
      if (err.stderr) saveStderrLog(planCli, "execution_plan", err.stderr);
      broadcastAll("ultraplan.planGenerationComplete", { status: "failed", error: err.message });
      console.error(`[discussion] Execution plan failed: ${err.message}`);
    }
  };

  /** Start the full workflow pipeline (called after allReady) */
  const startWorkflowPipeline = () => {
    if (!initialQuestion) return;

    console.log(`[workflow] Starting pipeline...`);

    // Step 1: Create workspace
    workspacePath = createWorkspace();
    broadcastAll("ultraplan.workspaceCreated", { path: workspacePath });

    // Step 2: Send initial question to all CLIs
    sendInitialQuestion(initialQuestion);
  };

  let autoSessionsCreated = false;

  const createAutoSessions = () => {
    if (autoSessionsCreated) return;
    autoSessionsCreated = true;

    for (const [name, id] of Object.entries(autoSessionIds)) {
      const cli = name as CliNameKey;
      try {
        const config = autoSessionConfigs[name];
        const session = manager.create({ id, cmd: config.cmd, args: config.args, cwd: projectPath });
        console.log(`[auto] created session ${id} (pid=${session.pid}) mode=${config.mode} cmd: ${config.cmd} ${config.args.join(" ")}`);

        if (config.mode === "shell") {
          shellPromptCount.set(id, 0);

          // ---- Readiness probe: listen for READY_KEYWORD in output ----
          sessionReadyState[cli] = "checking";
          broadcastReadyState(cli);
          console.log(`[ready] ${cli}: checking...`);

          let readyDetected = false;

          const onData = (data: string) => {
            if (readyDetected) return;
            // Strip ANSI escape codes for keyword detection
            const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
            if (clean.includes(READY_KEYWORD)) {
              readyDetected = true;
              session.off("data", onData);
              sessionReadyState[cli] = "ready";
              console.log(`[ready] ${cli}: ✓ ready`);
              broadcastReadyState(cli);
              checkAllReady();
            }
          };
          session.on("data", onData);

          // Timeout: mark as failed if no response
          setTimeout(() => {
            if (!readyDetected) {
              session.off("data", onData);
              sessionReadyState[cli] = "failed";
              sessionReadyError[cli] = `Timeout: no response within ${READY_TIMEOUT_MS / 1000}s`;
              console.log(`[ready] ${cli}: ✗ timeout`);
              broadcastReadyState(cli);
              checkAllReady();
            }
          }, READY_TIMEOUT_MS);

          // Session exit before ready
          session.on("exit", () => {
            if (!readyDetected) {
              readyDetected = true; // prevent timeout from double-firing
              session.off("data", onData);
              sessionReadyState[cli] = "failed";
              sessionReadyError[cli] = "Session exited before ready";
              console.log(`[ready] ${cli}: ✗ session exited`);
              broadcastReadyState(cli);
              checkAllReady();
            }
          });

          // Send readiness probe prompt
          const sendReadyProbe = () => {
            const command = buildCliCommand(name, READY_PROBE_PROMPT, true);
            const lineEnding = IS_WINDOWS ? "\r\n" : "\n";
            session.write(command + lineEnding);
            shellPromptCount.set(id, 1);
            console.log(`[ready] ${id}: sent readiness probe`);
          };

          if (name === "gemini") {
            setTimeout(sendReadyProbe, 2000);
          } else {
            setTimeout(sendReadyProbe, 1500);
          }
        }
      } catch (error) {
        console.error(`[auto] failed to create session ${id}:`, error);
        sessionReadyState[cli] = "failed";
        sessionReadyError[cli] = error instanceof Error ? error.message : "Unknown error";
        broadcastReadyState(cli);
        checkAllReady();
      }
    }
  };

  // ---- MIME type helper ----
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
  };

  const getMime = (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    return mimeTypes[ext] ?? "application/octet-stream";
  };

  // ---- HTTP server with static file serving + /api/config ----
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    // API: return auto-mode config (including session modes for frontend)
    if (url === "/api/config") {
      const sessionModes: Record<string, SessionMode> = {};
      for (const [name, id] of Object.entries(autoSessionIds)) {
        sessionModes[id] = autoSessionConfigs[name].mode;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          projectPath,
          autoSessions: autoSessionIds,
          sessionModes,
          cliStatus: lastTestResult,
          readyState: sessionReadyState,
          readyErrors: sessionReadyError,
          initialQuestion,
          questionStates,
          workspacePath,
          discussionFilePath,
          discussionState,
          discussionContent: discussionFilePath ? (() => { try { return fs.readFileSync(discussionFilePath, "utf-8"); } catch { return null; } })() : null,
          planContent: planFilePath ? (() => { try { return fs.readFileSync(planFilePath, "utf-8"); } catch { return null; } })() : null,
          planFilePath,
        })
      );
      return;
    }

    // API: return cached CLI test results + trigger new test
    if (url === "/api/cli-status") {
      if (req.method === "POST") {
        // Trigger a new test
        if (testInProgress) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ message: "Test already in progress" }));
          return;
        }

        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ message: "Test started" }));

        // Run test in background, broadcast via WebSocket
        testInProgress = true;
        broadcastAll("cli.testStarted", { message: "CLI connectivity test started" });

        testAllClis((status: CliStatus) => {
          broadcastAll("cli.status", status);
        }).then((result) => {
          lastTestResult = result;
          testInProgress = false;
          broadcastAll("cli.testComplete", result);
        }).catch(() => {
          testInProgress = false;
        });

        return;
      }

      // GET — return cached results
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ testInProgress, result: lastTestResult }));
      return;
    }

    // API: return current discussion state
    if (url === "/api/discussion-state" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(discussionState));
      return;
    }

    // API: return current discussion file content (for reconnect recovery)
    if (url === "/api/discussion-content" && req.method === "GET") {
      if (!discussionFilePath) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: null }));
        return;
      }
      try {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: fs.readFileSync(discussionFilePath, "utf-8"), path: discussionFilePath }));
      } catch {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: null }));
      }
      return;
    }

    // API: return current execution plan content (for reconnect recovery)
    if (url === "/api/plan-content" && req.method === "GET") {
      if (!planFilePath) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: null }));
        return;
      }
      try {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: fs.readFileSync(planFilePath, "utf-8"), path: planFilePath }));
      } catch {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ content: null }));
      }
      return;
    }

    // ---- Ultra Plan config API ----

    // GET /api/ultra-plan-config — return current config (merged with defaults)
    if (url === "/api/ultra-plan-config" && req.method === "GET") {
      const currentConfig = loadConfig();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(currentConfig));
      return;
    }

    // PUT /api/ultra-plan-config — save full config with validation
    if (url === "/api/ultra-plan-config" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as UltraPlanConfig;
          const result = saveConfig(parsed);
          if (result.ok) {
            const saved = loadConfig();
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(saved));
          } else {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ errors: result.errors }));
          }
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ errors: [{ field: "_", message: "无效的 JSON" }] }));
        }
      });
      return;
    }

    // POST /api/ultra-plan-config/reset — reset to defaults
    if (url === "/api/ultra-plan-config/reset" && req.method === "POST") {
      const defaults = resetConfig();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(defaults));
      return;
    }

    // GET /api/ultra-plan-config/defaults — return default values
    if (url === "/api/ultra-plan-config/defaults" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getDefaults()));
      return;
    }

    // Static file serving from web/dist/
    if (!fs.existsSync(webDistDir)) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Ultra Plan server is running.\nweb/dist/ not found - run 'npm run build' in web/ first.\n");
      return;
    }

    // Resolve file path (strip query strings)
    const urlPath = url.split("?")[0];
    let filePath = path.join(webDistDir, urlPath === "/" ? "index.html" : urlPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(webDistDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // If the resolved path is a directory, try index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    // SPA fallback: if file doesn't exist and no extension, serve index.html
    if (!fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      if (!ext) {
        filePath = path.join(webDistDir, "index.html");
      }
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const mime = getMime(filePath);
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { "content-type": mime });
    stream.pipe(res);
    stream.on("error", () => {
      res.writeHead(500);
      res.end("Internal server error");
    });
  });

  const wss = new WebSocketServer({ server });

  const send = (ws: WebSocket, type: string, payload: unknown) => {
    ws.send(JSON.stringify({ type, payload }));
  };

  /** Broadcast a message to all connected WebSocket clients */
  const broadcastAll = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(msg);
      }
    }
  };

  wss.on("connection", (ws) => {
    const detachments = new Map<string, () => void>();

    ws.on("message", (raw) => {
      let message: { type?: string; payload?: any };
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        send(ws, "session.error", { message: "Invalid JSON payload" });
        return;
      }

      const type = message.type;
      const payload = message.payload ?? {};

      if (!type) {
        send(ws, "session.error", { message: "Missing message type" });
        return;
      }

      switch (type) {
        case "session.list": {
          send(ws, "session.list", { sessions: manager.list() });
          break;
        }
        case "session.create": {
          const cmd = payload?.cmd as string | undefined;
          if (!cmd) {
            send(ws, "session.error", { message: "Missing cmd" });
            break;
          }
          const options = {
            id: payload?.id as string | undefined,
            cmd,
            args: Array.isArray(payload?.args) ? payload.args : undefined,
            cwd: payload?.cwd as string | undefined,
            env: payload?.env as NodeJS.ProcessEnv | undefined,
            cols: typeof payload?.cols === "number" ? payload.cols : undefined,
            rows: typeof payload?.rows === "number" ? payload.rows : undefined
          };
          try {
            const session = manager.create(options);
            send(ws, "session.created", {
              id: session.id,
              cmd: session.cmd,
              cwd: session.cwd,
              status: session.status
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Failed to create session";
            console.error("[session] create failed", error);
            send(ws, "session.error", {
              message: "Failed to create session",
              detail: message
            });
          }
          break;
        }
        case "session.attach": {
          const id = payload?.id as string | undefined;
          if (!id) {
            send(ws, "session.error", { message: "Missing session id" });
            break;
          }
          const existingDetach = detachments.get(id);
          if (existingDetach) {
            existingDetach();
            detachments.delete(id);
          }
          const detach = manager.attach(id, {
            onData: (data) => send(ws, "session.data", { id, data }),
            onExit: (exit) => send(ws, "session.exit", { id, ...exit }),
            onStatus: (status) => send(ws, "session.status", { id, status }),
            onError: () => send(ws, "session.error", { id, message: "Session error" })
          });
          if (!detach) {
            send(ws, "session.error", { id, message: "Session not found" });
            break;
          }
          detachments.set(id, detach);
          break;
        }
        case "session.input": {
          const id = payload?.id as string | undefined;
          const data = payload?.data as string | undefined;
          if (!id || typeof data !== "string") {
            send(ws, "session.error", { message: "Missing id or data" });
            break;
          }
          const session = manager.get(id);
          if (!session) {
            send(ws, "session.error", { id, message: "Session not found" });
            break;
          }
          session.write(data);
          break;
        }
        case "session.prompt": {
          // Shell-mode prompt: wrap user text in a CLI command
          const id = payload?.id as string | undefined;
          const prompt = payload?.prompt as string | undefined;
          if (!id || typeof prompt !== "string" || !prompt.trim()) {
            send(ws, "session.error", { message: "Missing id or prompt" });
            break;
          }
          const session = manager.get(id);
          if (!session) {
            send(ws, "session.error", { id, message: "Session not found" });
            break;
          }
          const cliName = getCliName(id);
          if (!cliName || !autoSessionConfigs[cliName] || autoSessionConfigs[cliName].mode !== "shell") {
            // Not a shell-mode session, fall back to raw input
            session.write(prompt + "\r");
            break;
          }
          const count = shellPromptCount.get(id) ?? 0;
          const isFirst = count === 0;
          const command = buildCliCommand(cliName, prompt, isFirst);
          const lineEnding = IS_WINDOWS ? "\r\n" : "\n";
          session.write(command + lineEnding);
          shellPromptCount.set(id, count + 1);
          console.log(`[prompt] ${id}: ${command}`);
          break;
        }
        case "session.resize": {
          const id = payload?.id as string | undefined;
          const cols = Number(payload?.cols);
          const rows = Number(payload?.rows);
          if (!id || !Number.isFinite(cols) || !Number.isFinite(rows)) {
            send(ws, "session.error", { message: "Missing id or size" });
            break;
          }
          const session = manager.get(id);
          if (!session) {
            send(ws, "session.error", { id, message: "Session not found" });
            break;
          }
          session.resize(cols, rows);
          break;
        }
        case "session.signal": {
          const id = payload?.id as string | undefined;
          const signal = payload?.signal as string | undefined;
          if (!id || !signal) {
            send(ws, "session.error", { message: "Missing id or signal" });
            break;
          }
          const session = manager.get(id);
          if (!session) {
            send(ws, "session.error", { id, message: "Session not found" });
            break;
          }
          session.signal(signal);
          break;
        }
        case "session.close": {
          const id = payload?.id as string | undefined;
          if (!id) {
            send(ws, "session.error", { message: "Missing session id" });
            break;
          }
          manager.close(id);
          break;
        }
        case "cli.test": {
          // Trigger CLI connectivity test
          if (testInProgress) {
            send(ws, "session.error", { message: "CLI test already in progress" });
            break;
          }
          const skipPromptTest = payload?.skipPromptTest === true;

          testInProgress = true;
          broadcastAll("cli.testStarted", { message: "CLI connectivity test started" });

          testAllClis((status: CliStatus) => {
            broadcastAll("cli.status", status);
          }, { skipPromptTest }).then((result) => {
            lastTestResult = result;
            testInProgress = false;
            broadcastAll("cli.testComplete", result);
          }).catch(() => {
            testInProgress = false;
          });
          break;
        }
        case "ultraplan.userInputSubmit": {
          const answers = payload?.answers as Record<number, string> | undefined;
          if (pendingUserInputResolve && answers) {
            const resolve = pendingUserInputResolve;
            pendingUserInputResolve = null;
            resolve(answers);
          }
          break;
        }
        default: {
          send(ws, "session.error", { message: `Unknown type: ${type}` });
        }
      }
    });

    ws.on("close", () => {
      for (const detach of detachments.values()) {
        detach();
      }
      detachments.clear();
    });
  });

  const shutdown = () => {
    manager.shutdown();
    wss.close(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] project path: ${projectPath}`);

    // Run quick CLI version check before creating sessions
    console.log(`[cli-test] checking CLI availability...`);
    testAllClis(undefined, { skipPromptTest: true })
      .then((result) => {
        lastTestResult = result;
        for (const cli of ["claude", "codex", "gemini"] as const) {
          const s = result.statuses[cli];
          if (s.availability === "installed") {
            console.log(`[cli-test] ${cli}: ✓ installed (v${s.version ?? "unknown"})`);
          } else if (s.availability === "not_found") {
            console.log(`[cli-test] ${cli}: ✗ not found`);
          } else {
            console.log(`[cli-test] ${cli}: ? ${s.availability} — ${s.error ?? ""}`);
          }
        }

        // Create sessions regardless of CLI availability
        createAutoSessions();
      })
      .catch((err) => {
        console.error(`[cli-test] check failed:`, err);
        // Still create sessions on failure
        createAutoSessions();
      });

    // Auto-open browser (unless suppressed by ULTRAPLAN_NO_BROWSER env)
    if (!process.env.ULTRAPLAN_NO_BROWSER) {
      const url = `http://localhost:${port}`;
      if (process.platform === "win32") {
        exec(`start "" "${url}"`);
      } else if (process.platform === "darwin") {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`).on("error", () => {
          // Silently fail on Linux if no browser available
        });
      }
    }
  });
}
