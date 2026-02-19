# CLAUDE.md

## Project Overview

Ultra Plan Mode — Windows-first multi-CLI orchestrator, orchestrates `claude`, `codex`, `gemini` CLI via Web UI for enhanced Plan Mode.

## Directory Structure

```
bin/
  ultra-plan.js        interactive CLI entry point (prompts for question, starts server)
  ultra-plan-config.js open config page (starts server if not running)
server/src/
  index.ts             main server (HTTP + WebSocket + readiness probe + workflow + config API)
  sessionManager.ts    PTY session management (256KB replay buffer)
  cliTester.ts         CLI availability detection
  configManager.ts     config persistence (UltraPlanConfig interface)
server/data/
  ultra-plan-config.defaults.json   default config values
  discussion-template.default.md    default discussion template (English v3.0)
  ultra-plan-config.json            user config (generated at runtime)
web/src/
  App.tsx              content-first dashboard (ContentViewer, CliStatusBar, PhaseBar, RoundsPanel)
  ConfigPage.tsx       config form page
  style.css            dark theme styles
```

## Quick Start

```bash
# As global npm package (users)
npm install -g ultra-plan-mode
cd /path/to/project && ultra-plan    # prompts for question, opens browser
ultra-plan-config                    # open config page

# Development
cd server && npm run build   # compile backend
cd web && npm run build      # build frontend
cd server && npm run dev     # dev mode
cd web && npm run dev        # Vite dev (5173->8787)
```

## Architecture: Read-Only CLIs + Server-Side File Management

All CLIs are **read-only**: they receive discussion file content inline in the prompt, output text only, and **never edit files**. The server handles all file writes via `appendToDiscussionFileDirect()`.

- **Discussion file init**: Server-side template string replacement (no CLI subprocess needed)
- **Phase A/B/C/D**: CLI outputs are parsed from JSONL, then appended to the discussion file by the server
- **Phase D**: Best available CLI (Claude→Gemini→Codex) synthesizes full discussion into `ExecutionPlan.md` (workspace root) and appends to Section 5 of the discussion file
- **Template**: English v3.0 framework (5 sections); content language controlled by `discussionLanguage` config (default: `zh-CN`)
- **All 3 CLIs participate equally** in all phases (no CLI-specific exclusions)

## Content Broadcast Pattern

After every `appendToDiscussionFileDirect()` call, the server immediately reads the file and broadcasts:
```typescript
broadcastAll("ultraplan.discussionContent", { content: fs.readFileSync(discFilePath, "utf-8") });
```
Phase D additionally broadcasts the plan text:
```typescript
broadcastAll("ultraplan.planContent", { content: clean, filePath: planFilePath });
```
`planFilePath` is a **module-level variable** (alongside `discussionFilePath`) so REST endpoints can read it.

WS events (content): `ultraplan.discussionContent` (S→C) | `ultraplan.planContent` (S→C, includes `filePath`)

## REST API

- `GET /api/config` — returns state + `discussionContent`, `planContent`, `planFilePath` (for page-reload recovery)
- `GET /api/discussion-content` — current discussion file text
- `GET /api/plan-content` — current ExecutionPlan.md text
- `GET /api/ultra-plan-config` (GET/PUT/reset/defaults) — user config

## CLI Subprocess Patterns

All CLIs use **stdin pipe for prompt** + **structured JSONL output**.

| CLI | Command | Output | Parser |
|-----|---------|--------|--------|
| Claude | `claude --dangerously-skip-permissions --verbose --output-format stream-json` | stream-json | `parseClaudeStreamJson()` |
| Codex | `codex exec --json --full-auto --skip-git-repo-check -` | JSONL | `parseCodexJsonl()` |
| Gemini | `gemini --yolo --output-format stream-json` | stream-json | `parseGeminiStreamJson()` |

All CLIs use `shell: true` (required for Windows .cmd wrappers), stdin write + `end()` for EOF.

## Idle Timeout (Two-Phase)

Idle timer only starts after **actual content events** are detected (`checkForContent()` string matching).

- **Claude**: Detects `"type":"text","text"` (NOT `"type":"assistant"`) — avoids premature timeout during extended thinking
- **Codex**: Detects `"type":"agent_message"` / `"type":"message_output_text"` / `"type":"task_complete"`
- **Gemini**: Detects `"role":"assistant"`

`parseClaudeStreamJson()` falls back to `thinking` blocks if no `text` blocks found.

## Phase B: Dynamic Rounds + Inter-round Analysis

Phase B uses a `while` loop. `discussionRounds` config is a **max cap** (default: 5, range: 1–10). After each round:

1. **Continuation analysis** — `analyzeForContinuation()` calls Claude Haiku → `{shouldContinue, reason}`
2. **User input analysis** — only if continuing: `analyzeForUserInput()` detects gaps → workflow pauses via `pendingUserInputResolve` Promise

`executeCliSubprocess` accepts optional `model?: string` — appends `--model <model>` to Claude args.

WS events (continuation): `ultraplan.continuationAnalyzing` → `ultraplan.continuationDecision` (S→C)
WS events (user input): `ultraplan.userInputAnalyzing` → `ultraplan.userInputNeeded` (S→C) | `ultraplan.userInputSubmit` (C→S) → `ultraplan.userInputReceived` (S→C)
WS events (Phase D): `ultraplan.planGenerationStart` → `ultraplan.planGenerationComplete` → `ultraplan.workflowComplete` (S→C)

## Frontend Components (App.tsx)

- **PhaseBar** — 4-phase A/B/C/D progress indicator
- **CliStatusBar** — compact horizontal 3-chip CLI status row
- **ContentViewer** — tabbed markdown viewer (讨论记录 / 执行计划); strips Section 5 from discussion tab; renders via `marked`; auto-scroll; copy-path button
- **RoundsPanel** — compact rounds display (only shown Phase B+)

## Key Conventions

- Chinese-friendly UI, dark theme (`#0d1117` bg, `#161b22` surface)
- Target CLIs: `claude`, `codex`, `gemini` (must be pre-installed and authenticated)
- Runtime defaults in `server/data/`
- `ULTRAPLAN_NO_BROWSER=1` suppresses auto-open browser
- WS event prefixes: `cli.*` (readiness), `ultraplan.*` (workflow)
- Workspace: `projectPath/.ultraplan/workspace_YYYYMMDD_HHmmss/`
- `discussionLanguage` config controls content language (default: `zh-CN`)
- `enablePlanGeneration` toggles Phase D (default: `true`); `ultraplan.workflowComplete` always broadcast at end
