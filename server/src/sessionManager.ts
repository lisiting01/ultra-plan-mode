import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";

export type SessionStatus = "running" | "exited" | "error";

export interface SessionCreateOptions {
  id?: string;
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface SessionInfo {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  status: SessionStatus;
  pid?: number;
  createdAt: string;
  exitedAt?: string;
}

export interface SessionExit {
  code: number | null;
  signal?: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const IS_WINDOWS = process.platform === "win32";

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(baseDir, "data");
const logsDir = path.join(baseDir, "logs");
const sessionsFile = path.join(dataDir, "sessions.json");
let storageReady = false;

const ensureStorage = () => {
  if (storageReady) {
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  storageReady = true;
};

const normalizeSessionInfo = (value: Partial<SessionInfo>): SessionInfo | null => {
  if (!value.id || !value.cmd) {
    return null;
  }
  const status =
    value.status === "running" || value.status === "exited" || value.status === "error"
      ? value.status
      : "exited";
  return {
    id: value.id,
    cmd: value.cmd,
    args: Array.isArray(value.args) ? value.args : [],
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    status,
    pid: typeof value.pid === "number" ? value.pid : undefined,
    createdAt:
      typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    exitedAt: typeof value.exitedAt === "string" ? value.exitedAt : undefined
  };
};

const loadSessionsFromDisk = (): SessionInfo[] => {
  ensureStorage();
  try {
    if (!fs.existsSync(sessionsFile)) {
      return [];
    }
    const raw = fs.readFileSync(sessionsFile, "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed as Record<string, SessionInfo>)
        : [];
    return records
      .map((record) => normalizeSessionInfo(record ?? {}))
      .filter((record): record is SessionInfo => Boolean(record));
  } catch {
    return [];
  }
};

const saveSessionsToDisk = (sessions: SessionInfo[]) => {
  ensureStorage();
  const payload = JSON.stringify(sessions, null, 2);
  fs.writeFileSync(sessionsFile, payload, "utf8");
};

const appendLogEvent = (id: string, event: Record<string, unknown>) => {
  ensureStorage();
  const line = `${JSON.stringify(event)}\n`;
  void fs.promises
    .appendFile(path.join(logsDir, `${id}.log`), line, "utf8")
    .catch((error) => {
      console.warn(`[session] failed to append log for ${id}`, error);
    });
};

const normalizeInput = (data: string) => {
  if (!IS_WINDOWS) {
    return data;
  }
  return data.replace(/\r?\n/g, "\r");
};

const normalizeOutput = (data: string) => {
  if (!IS_WINDOWS) {
    return data;
  }
  return data.replace(/\r\r\n/g, "\r\n");
};

const clampSize = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(2, Math.floor(value));
};

/** Max bytes to keep in the replay buffer per session */
const REPLAY_BUFFER_MAX = 256 * 1024; // 256 KB

export class Session extends EventEmitter {
  readonly id: string;
  readonly cmd: string;
  readonly args: string[];
  readonly cwd: string;
  readonly createdAt: string;
  status: SessionStatus = "running";
  pid?: number;
  exitedAt?: string;

  private readonly ptyProcess!: pty.IPty;

  /** Ring buffer that stores recent output for replay on late attach */
  private _replayChunks: string[] = [];
  private _replaySize = 0;

  constructor(options: SessionCreateOptions) {
    super();
    this.id = options.id ?? randomUUID();
    this.cmd = options.cmd;
    this.args = options.args ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.createdAt = new Date().toISOString();

    // Ensure cwd exists to avoid cryptic OS errors (e.g. Windows error 267)
    if (!fs.existsSync(this.cwd)) {
      fs.mkdirSync(this.cwd, { recursive: true });
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };

    const ptyOptions: pty.IPtyForkOptions & {
      useConpty?: boolean;
      encoding?: string;
      windowsHide?: boolean;
    } = {
      name: "xterm-256color",
      cols: clampSize(options.cols ?? DEFAULT_COLS, DEFAULT_COLS),
      rows: clampSize(options.rows ?? DEFAULT_ROWS, DEFAULT_ROWS),
      cwd: this.cwd,
      env,
      windowsHide: true
    };
    if (IS_WINDOWS) {
      ptyOptions.useConpty = true;
    } else {
      ptyOptions.encoding = "utf8";
    }

    const trySpawn = (cmd: string, args: string[], options: typeof ptyOptions) =>
      pty.spawn(cmd, args, options);

    // --- Spawn with fallback (Windows) ---
    let spawned = false;

    try {
      this.ptyProcess = trySpawn(this.cmd, this.args, ptyOptions);
      this.pid = this.ptyProcess.pid;
      spawned = true;
    } catch (error) {
      if (!IS_WINDOWS) {
        this.status = "error";
        this.emit("error", error);
        throw error;
      }

      const errno = (error as NodeJS.ErrnoException)?.code;
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      const isCreateProcessError =
        typeof message === "string" && message.includes("error code: 2");
      const isMissingCommand = errno === "ENOENT" || isCreateProcessError;
      const isShellCommand = /^cmd(\.exe)?$/i.test(path.basename(this.cmd));

      const windowsShell =
        process.env.ComSpec ??
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const fallbackOptions = { ...ptyOptions, useConpty: false };

      // Fallback 1: wrap in cmd.exe
      if (!spawned && isMissingCommand && !isShellCommand) {
        try {
          const fallbackArgs = ["/d", "/s", "/c", this.cmd, ...this.args];
          this.ptyProcess = trySpawn(windowsShell, fallbackArgs, fallbackOptions);
          this.pid = this.ptyProcess.pid;
          spawned = true;
        } catch (fallbackError) {
          // continue to next fallback
        }
      }

      // Fallback 2: disable ConPTY
      if (!spawned && isCreateProcessError && ptyOptions.useConpty) {
        try {
          this.ptyProcess = trySpawn(this.cmd, this.args, fallbackOptions);
          this.pid = this.ptyProcess.pid;
          spawned = true;
        } catch (fallbackError) {
          // continue
        }
      }

      if (!spawned) {
        this.status = "error";
        this.emit("error", error);
        throw error;
      }
    }

    // --- Always register PTY handlers (regardless of spawn path) ---
    this.ptyProcess.onData((data) => {
      const normalized = normalizeOutput(data);
      // Buffer output for replay
      this._replayChunks.push(normalized);
      this._replaySize += normalized.length;
      // Trim buffer if it exceeds max size
      while (this._replaySize > REPLAY_BUFFER_MAX && this._replayChunks.length > 1) {
        const removed = this._replayChunks.shift()!;
        this._replaySize -= removed.length;
      }
      this.emit("data", normalized);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.status = "exited";
      this.exitedAt = new Date().toISOString();
      this.emit("exit", { code: exitCode, signal });
      this.emit("status", this.status);
    });
  }

  info(): SessionInfo {
    return {
      id: this.id,
      cmd: this.cmd,
      args: this.args,
      cwd: this.cwd,
      status: this.status,
      pid: this.pid,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt
    };
  }

  /** Return all buffered output for replay */
  getReplayBuffer(): string {
    return this._replayChunks.join("");
  }

  write(data: string): void {
    if (this.status !== "running") {
      return;
    }
    const normalized = normalizeInput(data);
    if (normalized.length === 0) {
      return;
    }
    this.ptyProcess.write(normalized);
  }

  resize(cols: number, rows: number): void {
    if (this.status !== "running") {
      return;
    }
    const nextCols = clampSize(cols, DEFAULT_COLS);
    const nextRows = clampSize(rows, DEFAULT_ROWS);
    this.ptyProcess.resize(nextCols, nextRows);
  }

  signal(signal: string): void {
    if (this.status !== "running") {
      return;
    }
    if (IS_WINDOWS && signal === "SIGINT") {
      this.ptyProcess.write("\x03");
      return;
    }
    this.ptyProcess.kill(signal);
  }

  close(): void {
    if (this.status !== "running") {
      return;
    }
    this.ptyProcess.kill();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly metadata = new Map<string, SessionInfo>();

  constructor() {
    const loaded = loadSessionsFromDisk();
    const now = new Date().toISOString();
    let mutated = false;
    for (const session of loaded) {
      if (session.status === "running") {
        session.status = "exited";
        session.exitedAt ??= now;
        mutated = true;
      }
      this.metadata.set(session.id, session);
    }
    if (mutated) {
      saveSessionsToDisk(Array.from(this.metadata.values()));
    }
  }

  create(options: SessionCreateOptions): Session {
    const session = new Session(options);
    this.sessions.set(session.id, session);
    const createdInfo = session.info();
    this.metadata.set(session.id, createdInfo);
    saveSessionsToDisk(Array.from(this.metadata.values()));
    appendLogEvent(session.id, {
      ts: new Date().toISOString(),
      type: "start",
      cmd: session.cmd,
      args: session.args,
      cwd: session.cwd
    });
    session.on("data", (data: string) => {
      appendLogEvent(session.id, {
        ts: new Date().toISOString(),
        type: "data",
        payload: data
      });
    });
    session.on("exit", ({ code, signal }) => {
      const updated: SessionInfo = {
        ...session.info(),
        status: "exited",
        exitedAt: session.exitedAt ?? new Date().toISOString()
      };
      this.metadata.set(session.id, updated);
      saveSessionsToDisk(Array.from(this.metadata.values()));
      appendLogEvent(session.id, {
        ts: new Date().toISOString(),
        type: "exit",
        code,
        signal
      });
    });
    session.on("error", (error) => {
      const updated: SessionInfo = {
        ...session.info(),
        status: "error",
        exitedAt: session.exitedAt ?? new Date().toISOString()
      };
      this.metadata.set(session.id, updated);
      saveSessionsToDisk(Array.from(this.metadata.values()));
      appendLogEvent(session.id, {
        ts: new Date().toISOString(),
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    });
    return session;
  }

  list(): SessionInfo[] {
    for (const session of this.sessions.values()) {
      this.metadata.set(session.id, session.info());
    }
    return Array.from(this.metadata.values());
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  attach(
    id: string,
    handlers: {
      onData?: (data: string) => void;
      onExit?: (exit: SessionExit) => void;
      onStatus?: (status: SessionStatus) => void;
      onError?: (error: unknown) => void;
    }
  ): (() => void) | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }

    // Replay buffered output so late-connecting clients see prior output
    if (handlers.onData) {
      const replay = session.getReplayBuffer();
      if (replay.length > 0) {
        handlers.onData(replay);
      }
      session.on("data", handlers.onData);
    }
    if (handlers.onExit) {
      session.on("exit", handlers.onExit);
    }
    if (handlers.onStatus) {
      session.on("status", handlers.onStatus);
    }
    if (handlers.onError) {
      session.on("error", handlers.onError);
    }

    return () => {
      if (handlers.onData) {
        session.off("data", handlers.onData);
      }
      if (handlers.onExit) {
        session.off("exit", handlers.onExit);
      }
      if (handlers.onStatus) {
        session.off("status", handlers.onStatus);
      }
      if (handlers.onError) {
        session.off("error", handlers.onError);
      }
    };
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.close();
    return true;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    const removed = this.metadata.delete(id);
    if (removed) {
      saveSessionsToDisk(Array.from(this.metadata.values()));
    }
    return removed;
  }
}
