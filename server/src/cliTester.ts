import { exec } from "node:child_process";

// ---- Type definitions ----

export type CliName = "claude" | "codex" | "gemini";

export type CliAvailability =
  | "unknown"
  | "not_found"
  | "installed"
  | "authenticated"
  | "error";

export type CliTestPhase =
  | "pending"
  | "checking_version"
  | "checking_prompt"
  | "done";

export type CliStatus = {
  cli: CliName;
  availability: CliAvailability;
  version: string | null;
  phase: CliTestPhase;
  error: string | null;
  testedAt: number;
};

export type CliTestResult = {
  statuses: Record<CliName, CliStatus>;
  allPassed: boolean;
  testedAt: number;
};

// ---- Constants ----

const ALL_CLIS: CliName[] = ["claude", "codex", "gemini"];
const VERSION_TIMEOUT = 10_000; // 10s
const PROMPT_TIMEOUT = 30_000; // 30s

// ---- Helper: exec with timeout ----

function execWithTimeout(
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      }
    });

    // Safety: kill if process lingers beyond timeout
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs + 2000);

    child.on("exit", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
  });
}

// ---- Version check ----

function parseVersion(output: string): string | null {
  // Match patterns like "1.2.3", "v1.2.3", "claude 1.0.21", etc.
  const match = output.match(/v?(\d+\.\d+[\w.-]*)/);
  return match ? match[1] : null;
}

export async function checkVersion(
  cli: CliName
): Promise<{ installed: boolean; version: string | null; error: string | null }> {
  try {
    const { stdout, stderr } = await execWithTimeout(`${cli} --version`, VERSION_TIMEOUT);
    const combined = (stdout + " " + stderr).trim();
    const version = parseVersion(combined);
    return { installed: true, version, error: null };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);

    // Check if it's a "not found" error
    if (
      msg.includes("not recognized") || // Windows
      msg.includes("not found") || // Unix
      msg.includes("ENOENT") ||
      msg.includes("is not recognized as an internal or external command")
    ) {
      return { installed: false, version: null, error: `${cli} not found in PATH` };
    }

    // Other error (binary exists but crashed, timeout, etc.)
    return { installed: false, version: null, error: msg };
  }
}

// ---- Prompt check ----

/** Build the prompt-test command for a given CLI (mirrors buildCliCommand in index.ts) */
function buildTestCommand(cli: CliName): string {
  const prompt = "reply with just the word ok";
  switch (cli) {
    case "claude":
      return `claude --dangerously-skip-permissions -p "${prompt}"`;
    case "codex":
      return `codex --full-auto "${prompt}"`;
    case "gemini":
      return `gemini --yolo -p "${prompt}"`;
  }
}

export async function checkPrompt(
  cli: CliName
): Promise<{ authenticated: boolean; error: string | null }> {
  const command = buildTestCommand(cli);
  try {
    const { stdout, stderr } = await execWithTimeout(command, PROMPT_TIMEOUT);
    const combined = (stdout + " " + stderr).toLowerCase();

    // Check for common authentication error patterns
    if (
      combined.includes("unauthorized") ||
      combined.includes("unauthenticated") ||
      combined.includes("api key") ||
      combined.includes("api_key") ||
      combined.includes("not logged in") ||
      combined.includes("login required") ||
      combined.includes("authentication") ||
      combined.includes("auth error") ||
      combined.includes("invalid token") ||
      combined.includes("expired token") ||
      combined.includes("please login") ||
      combined.includes("please log in") ||
      combined.includes("sign in")
    ) {
      return { authenticated: false, error: `${cli} authentication failed` };
    }

    // If we got some output without auth errors, consider it authenticated
    return { authenticated: true, error: null };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { authenticated: false, error: msg };
  }
}

// ---- Orchestrator ----

export type TestProgressCallback = (status: CliStatus) => void;

export interface TestAllOptions {
  skipPromptTest?: boolean;
}

function makeInitialStatus(cli: CliName): CliStatus {
  return {
    cli,
    availability: "unknown",
    version: null,
    phase: "pending",
    error: null,
    testedAt: Date.now(),
  };
}

export async function testAllClis(
  onProgress?: TestProgressCallback,
  options?: TestAllOptions
): Promise<CliTestResult> {
  const statuses: Record<CliName, CliStatus> = {
    claude: makeInitialStatus("claude"),
    codex: makeInitialStatus("codex"),
    gemini: makeInitialStatus("gemini"),
  };

  const notify = (cli: CliName) => {
    if (onProgress) {
      onProgress({ ...statuses[cli] });
    }
  };

  // ---- Phase 1: Version checks (parallel) ----
  const versionChecks = ALL_CLIS.map(async (cli) => {
    statuses[cli].phase = "checking_version";
    statuses[cli].testedAt = Date.now();
    notify(cli);

    const result = await checkVersion(cli);

    if (result.installed) {
      statuses[cli].availability = "installed";
      statuses[cli].version = result.version;
    } else {
      statuses[cli].availability = "not_found";
      statuses[cli].error = result.error;
    }
    statuses[cli].testedAt = Date.now();

    // If skipPromptTest, mark as done here
    if (options?.skipPromptTest) {
      statuses[cli].phase = "done";
    }

    notify(cli);
  });

  await Promise.all(versionChecks);

  // ---- Phase 2: Prompt checks (parallel, only for installed CLIs) ----
  if (!options?.skipPromptTest) {
    const promptChecks = ALL_CLIS.filter(
      (cli) => statuses[cli].availability === "installed"
    ).map(async (cli) => {
      statuses[cli].phase = "checking_prompt";
      statuses[cli].testedAt = Date.now();
      notify(cli);

      const result = await checkPrompt(cli);

      if (result.authenticated) {
        statuses[cli].availability = "authenticated";
      } else {
        statuses[cli].availability = "error";
        statuses[cli].error = result.error;
      }
      statuses[cli].phase = "done";
      statuses[cli].testedAt = Date.now();
      notify(cli);
    });

    await Promise.all(promptChecks);

    // Mark non-installed CLIs as done too
    for (const cli of ALL_CLIS) {
      if (statuses[cli].phase !== "done") {
        statuses[cli].phase = "done";
        notify(cli);
      }
    }
  }

  const allPassed = ALL_CLIS.every(
    (cli) =>
      statuses[cli].availability === "authenticated" ||
      (options?.skipPromptTest && statuses[cli].availability === "installed")
  );

  return {
    statuses,
    allPassed,
    testedAt: Date.now(),
  };
}
