import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { marked } from "marked";
import ConfigPage from "./ConfigPage";

// Configure marked once at module level
marked.setOptions({ gfm: true, breaks: false });

type AppView = "dashboard" | "config";

type ConnectionState = "disconnected" | "connecting" | "connected";

type CliName = "claude" | "codex" | "gemini";

type ReadyState = "pending" | "checking" | "ready" | "failed";

type CliAvailability = "unknown" | "not_found" | "installed" | "authenticated" | "error";

type CliStatusInfo = {
  cli: CliName;
  availability: CliAvailability;
  version: string | null;
  phase: string;
  error: string | null;
  testedAt: number;
};

type CliTestResult = {
  statuses: Record<CliName, CliStatusInfo>;
  allPassed: boolean;
  testedAt: number;
};

type WsMessage = {
  type?: string;
  payload?: Record<string, any>;
};

type QuestionState = "pending" | "sending" | "answering" | "done" | "failed";

type DiscussionEntryState = "pending" | "responding" | "done" | "failed";

interface DiscussionEntry {
  cli: CliName;
  state: DiscussionEntryState;
  cleanOutput: string;
  error?: string;
}

interface DiscussionRound {
  roundNumber: number;
  speakers: CliName[];
  entries: Record<string, DiscussionEntry>;
  startedAt: string;
  completedAt?: string;
}

interface DiscussionState {
  currentRound: number;
  maxRounds: number;
  status: "pending" | "running" | "completed" | "failed";
  rounds: DiscussionRound[];
  participants: CliName[];
  discussionFilePath: string | null;
}

type WorkflowStage = "readiness" | "workspace" | "questioning" | "discussion-init" | "initial-views" | "discussion" | "consensus" | "plan-generation" | "complete";

type AutoConfig = {
  projectPath: string;
  autoSessions: { claude: string; codex: string; gemini: string };
  sessionModes?: Record<string, "interactive" | "shell">;
  cliStatus?: CliTestResult | null;
  readyState?: Record<CliName, ReadyState>;
  readyErrors?: Record<CliName, string | null>;
  initialQuestion?: string | null;
  questionStates?: Record<CliName, QuestionState>;
  workspacePath?: string | null;
  discussionFilePath?: string | null;
  discussionState?: DiscussionState | null;
  discussionContent?: string | null;
  planContent?: string | null;
  planFilePath?: string | null;
} | null;

const CLI_NAMES: CliName[] = ["claude", "codex", "gemini"];

const CLI_DISPLAY: Record<CliName, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#e8735a" },
  codex: { label: "Codex", color: "#22c55e" },
  gemini: { label: "Gemini", color: "#4285f4" },
};

/** Build WebSocket URL relative to the current page origin */
const getWsUrl = () => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
};

export default function App() {
  // ---- Hash-based view routing ----
  const getViewFromHash = (): AppView => {
    return window.location.hash === "#/config" ? "config" : "dashboard";
  };
  const [view, setView] = useState<AppView>(getViewFromHash);

  useEffect(() => {
    const onHashChange = () => setView(getViewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [projectPath, setProjectPath] = useState<string>("");
  const [autoConfig, setAutoConfig] = useState<AutoConfig>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  // ---- CLI readiness state ----
  const [readyStates, setReadyStates] = useState<Record<CliName, ReadyState>>({
    claude: "pending",
    codex: "pending",
    gemini: "pending",
  });
  const [readyErrors, setReadyErrors] = useState<Record<CliName, string | null>>({
    claude: null,
    codex: null,
    gemini: null,
  });
  const [allReady, setAllReady] = useState(false);

  // ---- CLI availability (from cliTester version check) ----
  const [cliStatuses, setCliStatuses] = useState<Record<CliName, CliStatusInfo | null>>({
    claude: null,
    codex: null,
    gemini: null,
  });

  // ---- Workflow pipeline state ----
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>("readiness");
  const [questionStates, setQuestionStates] = useState<Record<CliName, QuestionState>>({
    claude: "pending",
    codex: "pending",
    gemini: "pending",
  });
  const [initialQuestionText, setInitialQuestionText] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [discussionFilePath, setDiscussionFilePath] = useState<string | null>(null);

  // ---- Discussion state ----
  const [discussionState, setDiscussionState] = useState<DiscussionState | null>(null);
  const [currentDiscussionRound, setCurrentDiscussionRound] = useState<number>(0);
  const [discussionEntryStates, setDiscussionEntryStates] = useState<Record<CliName, DiscussionEntryState>>({
    claude: "pending",
    codex: "pending",
    gemini: "pending",
  });
  const [consensusStatus, setConsensusStatus] = useState<"pending" | "generating" | "completed" | "failed">("pending");
  const [planGenerationStatus, setPlanGenerationStatus] = useState<"pending" | "generating" | "completed" | "failed">("pending");
  const [planFilePath, setPlanFilePath] = useState<string | null>(null);

  // ---- Content viewer state ----
  const [discussionContent, setDiscussionContent] = useState<string>("");
  const [planContent, setPlanContent] = useState<string>("");

  // ---- Continuation analysis state ----
  const [continuationAnalyzing, setContinuationAnalyzing] = useState(false);

  // ---- User input (inter-round Q&A) state ----
  const [userInputPending, setUserInputPending] = useState(false);
  const [userInputRound, setUserInputRound] = useState(0);
  const [userInputQuestions, setUserInputQuestions] = useState<string[]>([]);
  const [userInputAnswers, setUserInputAnswers] = useState<Record<number, string>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const autoConfigRef = useRef(autoConfig);
  autoConfigRef.current = autoConfig;

  // ---- Fetch /api/config on mount ----
  useEffect(() => {
    fetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error("Config not available");
        return res.json();
      })
      .then((config: AutoConfig & {}) => {
        setAutoConfig(config);
        setProjectPath(config?.projectPath ?? "");
        setConfigLoaded(true);

        // Initialize readiness states from server
        if (config?.readyState) {
          setReadyStates(config.readyState);
        }
        if (config?.readyErrors) {
          setReadyErrors(config.readyErrors);
        }

        // Initialize CLI statuses from cliTester
        if (config?.cliStatus?.statuses) {
          setCliStatuses(config.cliStatus.statuses);
        }

        // Initialize workflow state from server
        if (config?.initialQuestion) {
          setInitialQuestionText(config.initialQuestion);
        }
        if (config?.questionStates) {
          setQuestionStates(config.questionStates);
        }
        if (config?.workspacePath) {
          setWorkspacePath(config.workspacePath);
        }
        if (config?.discussionFilePath) {
          setDiscussionFilePath(config.discussionFilePath);
        }
        if (config?.discussionState) {
          setDiscussionState(config.discussionState as DiscussionState);
          setCurrentDiscussionRound(config.discussionState.currentRound);
        }

        // Restore content on reconnect
        if (config?.discussionContent) {
          setDiscussionContent(config.discussionContent);
        }
        if (config?.planContent) {
          setPlanContent(config.planContent);
        }
        if (config?.planFilePath) {
          setPlanFilePath(config.planFilePath);
        }

        // Check if all are already ready
        if (config?.readyState) {
          const all = CLI_NAMES.every((c) => config.readyState![c] === "ready");
          setAllReady(all);
        }
      })
      .catch(() => {
        setAutoConfig(null);
        setConfigLoaded(true);
      });
  }, []);

  const send = useCallback((type: string, payload: unknown) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type, payload }));
  }, []);

  const submitUserInput = useCallback(() => {
    send("ultraplan.userInputSubmit", { answers: userInputAnswers });
  }, [send, userInputAnswers]);

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setConnectionState("connecting");

    const wsUrl = getWsUrl();
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    const handleIfCurrent = (action: () => void) => {
      if (wsRef.current !== socket) return;
      action();
    };

    socket.onopen = () =>
      handleIfCurrent(() => {
        setConnectionState("connected");
      });

    socket.onclose = () =>
      handleIfCurrent(() => {
        setConnectionState("disconnected");
      });

    socket.onerror = () =>
      handleIfCurrent(() => {
        setConnectionState("disconnected");
      });

    socket.onmessage = (event) =>
      handleIfCurrent(() => {
        let message: WsMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        const type = message.type;
        const payload = message.payload ?? {};

        switch (type) {
          case "cli.ready": {
            const cli = payload?.cli as CliName | undefined;
            const state = payload?.state as ReadyState | undefined;
            const error = payload?.error as string | null ?? null;
            if (cli && state && CLI_NAMES.includes(cli)) {
              setReadyStates((prev) => ({ ...prev, [cli]: state }));
              setReadyErrors((prev) => ({ ...prev, [cli]: error }));
            }
            break;
          }
          case "cli.allReady": {
            const states = payload?.states as Record<CliName, ReadyState> | undefined;
            const errors = payload?.errors as Record<CliName, string | null> | undefined;
            if (states) {
              setReadyStates(states);
            }
            if (errors) {
              setReadyErrors(errors);
            }
            setAllReady(payload?.allReady === true);
            break;
          }
          case "cli.status": {
            const cli = payload?.cli as CliName | undefined;
            if (cli && CLI_NAMES.includes(cli)) {
              setCliStatuses((prev) => ({
                ...prev,
                [cli]: payload as CliStatusInfo,
              }));
            }
            break;
          }
          case "cli.testComplete": {
            const result = payload as CliTestResult;
            if (result?.statuses) {
              setCliStatuses(result.statuses);
            }
            break;
          }
          // ---- Workflow pipeline messages ----
          case "ultraplan.workspaceCreated": {
            setWorkspacePath(payload?.path as string ?? null);
            setWorkflowStage("workspace");
            break;
          }
          case "ultraplan.initialQuestion": {
            setInitialQuestionText(payload?.question as string ?? null);
            setWorkflowStage("questioning");
            break;
          }
          case "ultraplan.questionComplete": {
            const cli = payload?.cli as CliName | undefined;
            const state = payload?.state as QuestionState | undefined;
            if (cli && state && CLI_NAMES.includes(cli)) {
              setQuestionStates((prev) => ({ ...prev, [cli]: state }));
            }
            break;
          }
          case "ultraplan.allQuestionsComplete": {
            const qStates = payload?.states as Record<CliName, QuestionState> | undefined;
            if (qStates) {
              setQuestionStates(qStates);
            }
            setWorkflowStage("discussion-init");
            break;
          }
          case "ultraplan.discussionFileInit": {
            const status = payload?.status as string | undefined;
            if (status === "skipped") {
              setWorkflowStage("complete");
            } else {
              setWorkflowStage("discussion-init");
            }
            break;
          }
          case "ultraplan.discussionFileCreated": {
            setDiscussionFilePath(payload?.path as string ?? null);
            setWorkflowStage("initial-views");
            break;
          }
          // ---- Discussion round messages ----
          case "ultraplan.initialViewStart": {
            setWorkflowStage("initial-views");
            setConsensusStatus("pending");
            break;
          }
          case "ultraplan.initialViewUpdate": {
            const cli = payload?.cli as CliName | undefined;
            const state = payload?.state as DiscussionEntryState | undefined;
            if (cli && state) {
              setDiscussionEntryStates((prev) => ({ ...prev, [cli]: state }));
            }
            break;
          }
          case "ultraplan.initialViewComplete": {
            setWorkflowStage("discussion");
            break;
          }
          case "ultraplan.discussionStart": {
            setWorkflowStage("discussion");
            const maxRounds = payload?.maxRounds as number | undefined;
            if (maxRounds && discussionState) {
              setDiscussionState({ ...discussionState, maxRounds });
            }
            break;
          }
          case "ultraplan.discussionRoundStart": {
            const round = payload?.round as number | undefined;
            if (round) {
              setCurrentDiscussionRound(round);
            }
            break;
          }
          case "ultraplan.discussionEntryUpdate": {
            const cli = payload?.cli as CliName | undefined;
            const state = payload?.state as DiscussionEntryState | undefined;
            const round = payload?.round as number | undefined;
            if (cli && state) {
              setDiscussionEntryStates((prev) => ({ ...prev, [cli]: state }));
            }
            if (round && discussionState) {
              setDiscussionState({ ...discussionState, currentRound: round });
            }
            break;
          }
          case "ultraplan.discussionRoundComplete": {
            setDiscussionEntryStates({
              claude: "pending",
              codex: "pending",
              gemini: "pending",
            });
            break;
          }
          case "ultraplan.discussionComplete": {
            const status = payload?.status as string | undefined;
            if (status === "completed") {
              setWorkflowStage("consensus");
            } else if (status === "failed") {
              setWorkflowStage("complete");
            }
            break;
          }
          case "ultraplan.consensusStart": {
            setWorkflowStage("consensus");
            setConsensusStatus("generating");
            break;
          }
          case "ultraplan.continuationAnalyzing": {
            setContinuationAnalyzing(true);
            break;
          }
          case "ultraplan.continuationDecision": {
            setContinuationAnalyzing(false);
            break;
          }
          case "ultraplan.userInputAnalyzing": {
            break;
          }
          case "ultraplan.userInputNeeded": {
            const questions = payload?.questions as string[] ?? [];
            const round = payload?.round as number ?? 0;
            setUserInputQuestions(questions);
            setUserInputRound(round);
            setUserInputAnswers({});
            setUserInputPending(true);
            break;
          }
          case "ultraplan.userInputReceived": {
            setUserInputPending(false);
            setUserInputQuestions([]);
            break;
          }
          case "ultraplan.consensusComplete": {
            const status = payload?.status as string | undefined;
            setConsensusStatus(status === "completed" ? "completed" : "failed");
            break;
          }
          case "ultraplan.planGenerationStart": {
            setWorkflowStage("plan-generation");
            setPlanGenerationStatus("generating");
            break;
          }
          case "ultraplan.planGenerationComplete": {
            const status = payload?.status as string | undefined;
            setPlanGenerationStatus(status === "completed" ? "completed" : "failed");
            if (payload?.planFilePath) {
              setPlanFilePath(payload.planFilePath as string);
            }
            break;
          }
          case "ultraplan.workflowComplete": {
            setWorkflowStage("complete");
            break;
          }
          // ---- Content viewer messages ----
          case "ultraplan.discussionContent": {
            setDiscussionContent(payload?.content as string ?? "");
            break;
          }
          case "ultraplan.planContent": {
            setPlanContent(payload?.content as string ?? "");
            if (payload?.filePath) {
              setPlanFilePath(payload.filePath as string);
            }
            break;
          }
          default:
            break;
        }
      });
  }, []);

  // Connect WebSocket only after config is loaded
  useEffect(() => {
    if (configLoaded) {
      connect();
    }
  }, [configLoaded, connect]);

  const readyCount = CLI_NAMES.filter((c) => readyStates[c] === "ready").length;
  const failedCount = CLI_NAMES.filter((c) => readyStates[c] === "failed").length;
  const checkingCount = CLI_NAMES.filter((c) => readyStates[c] === "checking").length;
  const questionDoneCount = CLI_NAMES.filter((c) => questionStates[c] === "done").length;

  // Determine banner text based on workflow stage
  const renderBanner = () => {
    if (!initialQuestionText) {
      if (allReady) {
        return (
          <div className="readiness-banner ready">
            <span className="readiness-icon">&#10003;</span>
            <span>所有 CLI 已就绪，可以开始工作</span>
          </div>
        );
      }
      if (checkingCount > 0) {
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>正在检测 CLI 连通性... ({readyCount}/{CLI_NAMES.length})</span>
          </div>
        );
      }
      if (failedCount > 0) {
        return (
          <div className="readiness-banner failed">
            <span className="readiness-icon">!</span>
            <span>{failedCount} 个 CLI 连接失败，{readyCount} 个就绪</span>
          </div>
        );
      }
      return (
        <div className="readiness-banner pending">
          <span className="readiness-icon">&#8230;</span>
          <span>等待启动...</span>
        </div>
      );
    }

    switch (workflowStage) {
      case "readiness":
        if (checkingCount > 0) {
          return (
            <div className="readiness-banner checking">
              <span className="readiness-spinner" />
              <span>正在检测 CLI 连通性... ({readyCount}/{CLI_NAMES.length})</span>
            </div>
          );
        }
        if (failedCount > 0) {
          return (
            <div className="readiness-banner failed">
              <span className="readiness-icon">!</span>
              <span>{failedCount} 个 CLI 连接失败，{readyCount} 个就绪</span>
            </div>
          );
        }
        return (
          <div className="readiness-banner pending">
            <span className="readiness-icon">&#8230;</span>
            <span>等待启动...</span>
          </div>
        );
      case "workspace":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>正在创建工作区...</span>
          </div>
        );
      case "questioning":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>初始问题回答中... ({questionDoneCount}/{CLI_NAMES.length})</span>
          </div>
        );
      case "discussion-init":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>正在初始化讨论文件...</span>
          </div>
        );
      case "initial-views":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>初始观点补充中...</span>
          </div>
        );
      case "discussion":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            {continuationAnalyzing
              ? <span>AI 正在判断是否需要继续讨论...</span>
              : <span>专家讨论进行中... 第 {currentDiscussionRound} 轮（最多 {discussionState?.maxRounds ?? 5} 轮）</span>
            }
          </div>
        );
      case "consensus":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>正在生成共识总结...</span>
          </div>
        );
      case "plan-generation":
        return (
          <div className="readiness-banner checking">
            <span className="readiness-spinner" />
            <span>正在生成执行计划...</span>
          </div>
        );
      case "complete":
        return (
          <div className="readiness-banner ready">
            <span className="readiness-icon">&#10003;</span>
            <span>讨论已完成{planGenerationStatus === "completed" ? "，执行计划已生成" : ""}</span>
          </div>
        );
    }
  };

  return (
    <main className="app">
      <header className="header-row">
        <div className="brand">
          <span className={`brand-dot ${connectionState}`} />
          <span className="brand-name">Ultra Plan Mode</span>
        </div>
        <nav className="header-nav">
          <a className={`nav-link ${view === "dashboard" ? "nav-active" : ""}`} href="#/">
            面板
          </a>
          <a className={`nav-link ${view === "config" ? "nav-active" : ""}`} href="#/config">
            配置
          </a>
        </nav>
        <div className="ws-status">
          <span className={`ws-dot ${connectionState}`} />
          <span className="ws-label">
            {connectionState === "connected" ? "已连接" : connectionState === "connecting" ? "连接中" : "未连接"}
          </span>
        </div>
      </header>

      {view === "config" ? (
        <ConfigPage />
      ) : (
        <>
          {/* Context Card: project path + initial question */}
          <div className="context-card">
            <div className="context-row">
              <span className="context-label">项目</span>
              <span className="context-value context-mono">{projectPath || "—"}</span>
            </div>
            {initialQuestionText && (
              <div className="context-row">
                <span className="context-label">问题</span>
                <span className="context-value">{initialQuestionText}</span>
              </div>
            )}
          </div>

          {/* Phase Bar (A/B/C/D) — only when workflow has started */}
          {initialQuestionText && (
            <PhaseBar
              workflowStage={workflowStage}
              currentRound={currentDiscussionRound}
              maxRounds={discussionState?.maxRounds ?? 5}
              planGenerationStatus={planGenerationStatus}
            />
          )}

          {/* Status Banner */}
          <div className="readiness-summary">
            {renderBanner()}
          </div>

          {/* CLI Status Bar — compact horizontal strip */}
          <CliStatusBar
            readyStates={readyStates}
            cliStatuses={cliStatuses}
            questionStates={questionStates}
            discussionEntryStates={discussionEntryStates}
            currentRound={currentDiscussionRound}
            workflowStage={workflowStage}
          />

          {/* Content Viewer — main content area */}
          <ContentViewer
            discussionContent={discussionContent}
            planContent={planContent}
            planFilePath={planFilePath}
            workflowStage={workflowStage}
          />

          {/* Rounds Panel — only during/after discussion */}
          {initialQuestionText && discussionState && (
            workflowStage === "discussion" || workflowStage === "consensus" || workflowStage === "plan-generation" || workflowStage === "complete"
          ) && (
            <RoundsPanel
              discussionState={discussionState}
              currentRound={currentDiscussionRound}
              entryStates={discussionEntryStates}
              workflowStage={workflowStage}
            />
          )}

          {/* User Input Panel (inter-round Q&A) */}
          {userInputPending && (
            <div className="user-input-panel">
              <div className="user-input-header">
                <span className="user-input-icon">&#9998;</span>
                <h3>专家需要进一步信息（Round {userInputRound} 后）</h3>
              </div>
              <p className="user-input-desc">Haiku 分析发现以下信息缺口，请补充以改善下一轮讨论：</p>
              {userInputQuestions.map((q, i) => (
                <div key={i} className="user-input-question">
                  <label className="user-input-label">{i + 1}. {q}</label>
                  <textarea
                    className="user-input-textarea"
                    value={userInputAnswers[i] ?? ""}
                    onChange={(e) => setUserInputAnswers(prev => ({ ...prev, [i]: e.target.value }))}
                    rows={3}
                    placeholder="请输入您的回答..."
                  />
                </div>
              ))}
              <button
                className="user-input-submit"
                onClick={submitUserInput}
                disabled={userInputQuestions.some((_, i) => !userInputAnswers[i]?.trim())}
              >
                提交并继续讨论
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

// ---- PhaseBar component ----

type PhaseBarProps = {
  workflowStage: WorkflowStage;
  currentRound: number;
  maxRounds: number;
  planGenerationStatus: "pending" | "generating" | "completed" | "failed";
};

function PhaseBar({ workflowStage, currentRound, maxRounds, planGenerationStatus }: PhaseBarProps) {
  const phaseA_stages: WorkflowStage[] = ["workspace", "questioning", "discussion-init", "initial-views"];
  const phaseB_stages: WorkflowStage[] = ["discussion"];
  const phaseC_stages: WorkflowStage[] = ["consensus"];
  const phaseD_stages: WorkflowStage[] = ["plan-generation", "complete"];

  const getPhaseStatus = (activeStages: WorkflowStage[], doneAfter: WorkflowStage[]) => {
    if (activeStages.includes(workflowStage)) return "active";
    if (doneAfter.includes(workflowStage)) return "done";
    // check if we're past this phase
    const allStages: WorkflowStage[] = ["readiness", "workspace", "questioning", "discussion-init", "initial-views", "discussion", "consensus", "plan-generation", "complete"];
    const currentIdx = allStages.indexOf(workflowStage);
    const lastActiveIdx = Math.max(...activeStages.map(s => allStages.indexOf(s)));
    return currentIdx > lastActiveIdx ? "done" : "pending";
  };

  const phaseAStatus = getPhaseStatus(phaseA_stages, ["discussion", "consensus", "plan-generation", "complete"]);
  const phaseBStatus = getPhaseStatus(phaseB_stages, ["consensus", "plan-generation", "complete"]);
  const phaseCStatus = getPhaseStatus(phaseC_stages, ["plan-generation", "complete"]);
  const phaseDStatus = getPhaseStatus(phaseD_stages, []);

  // For Phase D, if we're at complete, show done
  const phaseDFinal = workflowStage === "complete" ? "done" : phaseDStatus;

  return (
    <div className="phase-bar">
      <PhaseStep label="A 初始准备" status={phaseAStatus} />
      <div className="phase-connector" />
      <PhaseStep
        label="B 专家讨论"
        status={phaseBStatus}
        badge={phaseBStatus === "active" && currentRound > 0 ? `R${currentRound}/${maxRounds}` : undefined}
      />
      <div className="phase-connector" />
      <PhaseStep label="C 共识总结" status={phaseCStatus} />
      <div className="phase-connector" />
      <PhaseStep
        label="D 执行计划"
        status={phaseDFinal}
        badge={phaseDFinal === "done" && planGenerationStatus === "completed" ? "✓" : undefined}
      />
    </div>
  );
}

type PhaseStepProps = {
  label: string;
  status: "pending" | "active" | "done";
  badge?: string;
};

function PhaseStep({ label, status, badge }: PhaseStepProps) {
  return (
    <div className={`phase-step ${status}`}>
      <div className="phase-step-indicator">
        {status === "pending" && <span className="phase-dot" />}
        {status === "active" && <span className="readiness-spinner phase-spinner" />}
        {status === "done" && <span className="phase-check">✓</span>}
      </div>
      <span className="phase-step-label">{label}</span>
      {badge && <span className="phase-badge">{badge}</span>}
    </div>
  );
}

// ---- CliStatusBar component ----

type CliStatusBarProps = {
  readyStates: Record<CliName, ReadyState>;
  cliStatuses: Record<CliName, CliStatusInfo | null>;
  questionStates: Record<CliName, QuestionState>;
  discussionEntryStates: Record<CliName, DiscussionEntryState>;
  currentRound: number;
  workflowStage: WorkflowStage;
};

function CliStatusBar({ readyStates, cliStatuses, questionStates, discussionEntryStates, currentRound, workflowStage }: CliStatusBarProps) {
  return (
    <div className="cli-status-bar">
      {CLI_NAMES.map((cli) => {
        const { color, label } = CLI_DISPLAY[cli];
        const rs = readyStates[cli];
        const qs = questionStates[cli];
        const ds = discussionEntryStates[cli];
        const isResponding = ds === "responding";
        const isAnswering = qs === "answering" || qs === "sending";
        const isChecking = rs === "checking";

        return (
          <div key={cli} className={`cli-chip rs-${rs}`} style={{ borderLeftColor: color }}>
            <span className="cli-chip-dot" style={{ background: color }} />
            <span className="cli-chip-name">{label}</span>
            {cliStatuses[cli]?.version && (
              <span className="cli-chip-ver">v{cliStatuses[cli]!.version}</span>
            )}
            <span className="cli-chip-status">
              {rs === "failed" && <span className="chip-failed">✗ 失败</span>}
              {(isResponding || isAnswering || isChecking) && (
                <><span className="readiness-spinner chip-spinner" /> {isResponding ? `讨论中 R${currentRound}` : isAnswering ? "回答中" : "检测中"}</>
              )}
              {rs === "ready" && !isResponding && !isAnswering && (
                <span className="chip-ready">✓ 就绪</span>
              )}
              {rs === "pending" && !isChecking && <span className="chip-pending">···</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- ContentViewer component ----

type ContentViewerProps = {
  discussionContent: string;
  planContent: string;
  planFilePath: string | null;
  workflowStage: WorkflowStage;
};

function ContentViewer({ discussionContent, planContent, planFilePath, workflowStage }: ContentViewerProps) {
  const [activeTab, setActiveTab] = useState<"discussion" | "plan">("discussion");
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Strip Section 5 (Execution Plan) from discussion view — it lives in its own tab
  const filteredDiscussion = useMemo(() => {
    if (!discussionContent) return "";
    const idx = discussionContent.indexOf("\n## 5.");
    return idx === -1 ? discussionContent : discussionContent.slice(0, idx);
  }, [discussionContent]);

  // Auto-switch to plan tab when plan content arrives
  useEffect(() => {
    if (planContent) setActiveTab("plan");
  }, [planContent]);

  // Auto-scroll on content update
  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filteredDiscussion, planContent, autoScroll, activeTab]);

  const displayContent = activeTab === "plan" ? planContent : filteredDiscussion;
  const isEmpty = !displayContent;

  // Render markdown to HTML
  const renderedHtml = useMemo(() => {
    if (!displayContent) return "";
    try {
      return marked.parse(displayContent) as string;
    } catch {
      return `<pre>${displayContent}</pre>`;
    }
  }, [displayContent]);

  const copyPath = () => {
    if (planFilePath) {
      navigator.clipboard.writeText(planFilePath).catch(() => {});
    }
  };

  return (
    <div className="content-viewer">
      <div className="content-viewer-toolbar">
        <div className="content-tabs">
          <button
            className={`content-tab ${activeTab === "discussion" ? "active" : ""}`}
            onClick={() => setActiveTab("discussion")}
          >
            讨论记录
            {filteredDiscussion && (
              <span className="content-size">{Math.ceil(filteredDiscussion.length / 1000)}K</span>
            )}
          </button>
          {planContent && (
            <button
              className={`content-tab ${activeTab === "plan" ? "active" : ""}`}
              onClick={() => setActiveTab("plan")}
            >
              执行计划
              <span className="content-size">{Math.ceil(planContent.length / 1000)}K</span>
            </button>
          )}
        </div>
        <div className="content-actions">
          {activeTab === "plan" && planFilePath && (
            <button className="content-action-btn" onClick={copyPath}>
              复制路径
            </button>
          )}
          <button
            className={`content-action-btn ${autoScroll ? "active" : ""}`}
            onClick={() => setAutoScroll((v) => !v)}
          >
            {autoScroll ? "自动滚动" : "手动"}
          </button>
        </div>
      </div>
      <div className="content-body" ref={bodyRef}>
        {isEmpty ? (
          <span className="content-placeholder">
            {workflowStage === "readiness" || workflowStage === "workspace"
              ? "等待工作流启动..."
              : "等待讨论文件初始化..."}
          </span>
        ) : (
          <div className="md" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        )}
      </div>
    </div>
  );
}

// ---- RoundsPanel component (compact, replaces DiscussionProgress) ----

type RoundsPanelProps = {
  discussionState: DiscussionState;
  currentRound: number;
  entryStates: Record<CliName, DiscussionEntryState>;
  workflowStage: WorkflowStage;
};

function RoundsPanel({ discussionState, currentRound, entryStates, workflowStage }: RoundsPanelProps) {
  const { maxRounds, rounds, participants } = discussionState;

  return (
    <div className="rounds-panel">
      <div className="rounds-panel-header">
        <span className="rounds-panel-title">讨论轮次</span>
        <span className="rounds-panel-counter">第 {Math.max(1, currentRound)} / {maxRounds} 轮</span>
      </div>
      <div className="rounds-list">
        {Array.from({ length: maxRounds }, (_, i) => i + 1).map((roundNum) => {
          const round = rounds.find((r) => r.roundNumber === roundNum);
          const isCurrentRound = roundNum === currentRound && workflowStage === "discussion";
          const isPastRound = roundNum < currentRound;
          const speakers = round?.speakers || rotateSpeakersLocal(participants, roundNum);

          return (
            <div
              key={roundNum}
              className={`round-row ${isCurrentRound ? "active" : ""} ${isPastRound ? "done" : ""}`}
            >
              <span className="round-label">R{roundNum}</span>
              <div className="round-speakers">
                {speakers.map((cli) => {
                  const entry = round?.entries?.[cli];
                  const state = entry?.state || (roundNum < currentRound ? "done" : entryStates[cli] || "pending");
                  return (
                    <span
                      key={cli}
                      className={`round-speaker ${state}`}
                      style={{ borderColor: CLI_DISPLAY[cli].color }}
                    >
                      <span className="round-speaker-dot" style={{ background: CLI_DISPLAY[cli].color }} />
                      <span>{CLI_DISPLAY[cli].label}</span>
                      <span className="round-speaker-status">
                        {state === "pending" && "·"}
                        {state === "responding" && <span className="discussion-mini-spinner" />}
                        {state === "done" && "✓"}
                        {state === "failed" && "✗"}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Local helper to calculate speaker rotation for display */
function rotateSpeakersLocal(participants: CliName[], round: number): CliName[] {
  const offset = (round - 1) % participants.length;
  return [...participants.slice(offset), ...participants.slice(0, offset)];
}
