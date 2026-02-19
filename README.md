# Ultra Plan Mode

Windows-first multi-CLI orchestrator — orchestrates Claude Code, Codex, and Gemini CLI via Web UI for enhanced Plan Mode.

## Installation

```bash
npm install -g ultra-plan-mode
```

## Usage

```bash
cd /path/to/your/project
ultra-plan
# Prompts: Planning question: [type your question, press Enter]

# Open config page
ultra-plan-config
```

Browser auto-opens → three CLI sessions created → readiness probe completes → frontend shows ready state.
Once the initial question is submitted, the workflow pipeline starts automatically after all CLIs are ready.

## Prerequisites

- Node.js 18+
- `claude` CLI (installed and authenticated)
- `codex` CLI (installed and authenticated)
- `gemini` CLI (installed and authenticated)

## Structure

```
bin/
  ultra-plan.js          interactive CLI entry point (prompts for question, starts server)
  ultra-plan-config.js   open config page (starts server if not running)
server/          Node.js + TypeScript backend
  src/
    index.ts           HTTP + WebSocket + auto-sessions + readiness probe + workflow pipeline + config API
    sessionManager.ts  PTY session management (256KB output replay buffer)
    cliTester.ts       CLI availability detection (version/auth, independent of PTY)
    configManager.ts   Config persistence (load/save/validate/reset)
  data/
    ultra-plan-config.defaults.json   Default config values
    discussion-template.default.md    Default discussion template (English v3.0)
    ultra-plan-config.json            User-saved config (generated at runtime)
  dist/                Compiled output
web/             Vite + React frontend
  src/
    App.tsx            Content-first dashboard (ContentViewer, CliStatusBar, PhaseBar, RoundsPanel)
    ConfigPage.tsx     Config form page
    style.css          Dark theme styles
  dist/                Build output (served statically by server)
```

## Development

```bash
# Backend
cd server && npm run dev           # tsx dev mode
cd server && npm run build         # compile TypeScript

# Frontend
cd web && npm run dev              # Vite dev server (5173), auto-proxy /api and WS to 8787
cd web && npm run build            # production build

# Production mode
cd server && npm run build
cd web && npm run build
node server/dist/index.js [projectPath] ["initialQuestion"]
```

## How It Works

1. `server/dist/index.js` starts HTTP server (port 8787), serves `web/dist/` static files
2. Runs CLI version detection in parallel (`claude/codex/gemini --version`)
3. Auto-creates three PTY shell sessions, sends readiness probe prompts
4. Monitors PTY output for readiness keywords to confirm each CLI is responsive
5. Auto-opens browser; frontend receives readiness updates via WebSocket
6. Once all CLIs are ready and an initial question exists, the workflow pipeline starts

### Web UI: Content-First Design

The frontend is built around **ContentViewer** — a tabbed markdown viewer that occupies the majority of the viewport:

- **讨论记录 tab** — live discussion file content, updated after each CLI contribution (Sections 1–4 only, Section 5 excluded)
- **执行计划 tab** — appears automatically when Phase D completes; rendered markdown with copy-path button
- Auto-scroll toggle; page-reload restores content from `/api/config`

Rendered via [`marked`](https://github.com/markedjs/marked) (GFM). Other components: **PhaseBar** (A/B/C/D), **CliStatusBar** (3-chip row), **RoundsPanel** (Phase B+).

### Content Broadcast API

After every file write, the server broadcasts updated content via WebSocket:
- `ultraplan.discussionContent` — full discussion file (Sections 1–4 growing in real-time)
- `ultraplan.planContent` — execution plan text + file path (Phase D only)

Recovery endpoints for page reload:
- `GET /api/discussion-content` — current discussion file
- `GET /api/plan-content` — current ExecutionPlan.md
- `GET /api/config` — also includes `discussionContent`, `planContent`, `planFilePath`

### Architecture: Read-Only CLIs

All CLIs are **read-only** — they receive discussion file content **inline in the prompt**, output text only, and **never edit files**. The server handles all file writes via `appendToDiscussionFileDirect()`.

This eliminates the root cause of most failures: CLIs trying to edit files with varying reliability (especially Codex with non-ASCII paths).

### Config System

Manage runtime parameters via the Web UI config page (`#/config`) or by editing files directly:

- **Readiness probe**: keyword, prompt, timeout
- **System prompt**: optional, injected before the initial question
- **Discussion template**: English v3.0 Markdown template written to workspace
- **Workflow timeouts**: idle completion, question hard timeout
- **Discussion language**: controls content language (default: `zh-CN`); template framework is English
- **Plan generation**: `enablePlanGeneration` toggles Phase D execution plan output (default: `true`)

Default sources:
- `server/data/ultra-plan-config.defaults.json` — simple config fields
- `server/data/discussion-template.default.md` — discussion template

Edit these files to change defaults without recompilation. Config changes take effect on next startup.

### Readiness Probe

- Probe prompt and keyword are configurable via the config page
- State flow: `pending -> checking -> ready | failed`
- WS broadcast: `cli.ready` (per-CLI), `cli.allReady` (aggregated)

### Workflow Pipeline

Trigger: all CLIs ready + initial question provided at startup.

1. **Create workspace** — `projectPath/.ultraplan/workspace_YYYYMMDD_HHmmss/` with `claude/`, `codex/`, `gemini/` subdirs and template file
2. **Send initial question** — 3 independent subprocesses `spawn()` in parallel, output saved to workspace
3. **Initialize discussion file** — Server-side template fill (string replacement for topic, date, participants, background). No CLI subprocess needed.
4. **Phase A: Initial perspectives** — All 3 CLIs receive file content inline, output text only. Server appends each response to Section 2.
5. **Phase B: Dynamic discussion rounds** — CLIs take turns per round (rotating order). Each receives updated file content, outputs discussion contribution. Server appends to Section 3. `discussionRounds` config is a **max cap** (default: 5, range: 1–10) — after each round, Claude Haiku runs two analyses: (a) **continuation analysis** (`analyzeForContinuation`) to decide if another round is needed (stops early when consensus forms or content becomes repetitive); (b) **user input analysis** (`analyzeForUserInput`, only if continuing) to detect information gaps — if found, workflow pauses and the frontend presents questions for the user to answer, with answers written to the discussion file before the next round.
6. **Phase C: Consensus summary** — One CLI generates summary from full discussion. Server appends to Section 4.
7. **Phase D: Execution plan** — Best available CLI (Claude→Gemini→Codex) synthesizes the full discussion into a structured, actionable plan document. Written to `{workspace}/ExecutionPlan.md` (primary deliverable) and appended to Section 5 of the discussion file. Controlled by `enablePlanGeneration` config (default: `true`). `ultraplan.workflowComplete` is broadcast at the end regardless.

### CLI Subprocess Communication

All CLIs use **stdin pipe for prompt delivery** + **structured JSONL output**, avoiding Windows cmd.exe argument limitations.

| CLI | Command | Output Format | Parser |
|-----|---------|--------------|--------|
| Claude | `claude --dangerously-skip-permissions --verbose --output-format stream-json` | stream-json | `parseClaudeStreamJson()` |
| Codex | `codex exec --json --full-auto --skip-git-repo-check -` | JSONL | `parseCodexJsonl()` |
| Gemini | `gemini --yolo --output-format stream-json` | stream-json | `parseGeminiStreamJson()` |

**Idle timeout**: Two-phase design — idle timer only starts after actual content events are detected (not init/meta events). Claude specifically checks for `"type":"text","text"` to avoid premature timeout during extended thinking.
