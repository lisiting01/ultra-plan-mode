import { useEffect, useState, useCallback } from "react";

type UltraPlanConfig = {
  readyKeyword: string;
  readyProbePrompt: string;
  readyTimeoutMs: number;
  systemPrompt: string;
  discussionTemplate: string;
  idleCompleteMs: number;
  questionTimeoutMs: number;
  discussionRounds: number;
  discussionTurnTimeoutMs: number;
  enableConsensusSummary: boolean;
};

type SaveStatus = "idle" | "saving" | "saved" | "error";

const emptyConfig: UltraPlanConfig = {
  readyKeyword: "",
  readyProbePrompt: "",
  readyTimeoutMs: 60000,
  systemPrompt: "",
  discussionTemplate: "",
  idleCompleteMs: 20000,
  questionTimeoutMs: 300000,
  discussionRounds: 5,
  discussionTurnTimeoutMs: 300000,
  enableConsensusSummary: true,
};

export default function ConfigPage() {
  const [config, setConfig] = useState<UltraPlanConfig>(emptyConfig);
  const [defaults, setDefaults] = useState<UltraPlanConfig>(emptyConfig);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [confirmReset, setConfirmReset] = useState(false);

  // Fetch current config and defaults on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/ultra-plan-config").then((r) => r.json()),
      fetch("/api/ultra-plan-config/defaults").then((r) => r.json()),
    ])
      .then(([current, defs]) => {
        setConfig(current as UltraPlanConfig);
        setDefaults(defs as UltraPlanConfig);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        setErrorMsg("无法加载配置");
      });
  }, []);

  const updateField = useCallback(
    <K extends keyof UltraPlanConfig>(field: K, value: UltraPlanConfig[K]) => {
      setConfig((prev) => ({ ...prev, [field]: value }));
      setSaveStatus("idle");
    },
    []
  );

  // Check if readyKeyword appears in readyProbePrompt
  const keywordWarning =
    config.readyKeyword.trim() &&
    config.readyProbePrompt.trim() &&
    !config.readyProbePrompt.includes(config.readyKeyword);

  const handleSave = async () => {
    setSaveStatus("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/ultra-plan-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        const saved = (await res.json()) as UltraPlanConfig;
        setConfig(saved);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        const data = await res.json();
        const msgs = (data.errors as { field: string; message: string }[])
          ?.map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        setErrorMsg(msgs || "保存失败");
        setSaveStatus("error");
      }
    } catch {
      setErrorMsg("网络错误");
      setSaveStatus("error");
    }
  };

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    try {
      const res = await fetch("/api/ultra-plan-config/reset", { method: "POST" });
      if (res.ok) {
        const resetted = (await res.json()) as UltraPlanConfig;
        setConfig(resetted);
        setSaveStatus("saved");
        setErrorMsg("");
        setTimeout(() => setSaveStatus("idle"), 3000);
      }
    } catch {
      setErrorMsg("重置失败");
      setSaveStatus("error");
    }
  };

  if (loading) {
    return (
      <div className="config-page">
        <div className="config-loading">加载配置中...</div>
      </div>
    );
  }

  return (
    <div className="config-page">
      <div className="config-notice">
        配置更改将在下次启动时生效
      </div>

      {/* Section 1: Readiness Probe */}
      <div className="config-section">
        <h2 className="config-section-title">就绪探测配置</h2>

        <div className="config-field">
          <label className="config-label">就绪关键词</label>
          <input
            className="config-input config-mono"
            type="text"
            value={config.readyKeyword}
            onChange={(e) => updateField("readyKeyword", e.target.value)}
            placeholder={defaults.readyKeyword}
            maxLength={50}
          />
          <span className="config-hint">
            CLI 返回此关键词即视为就绪（仅字母、数字、下划线）
          </span>
        </div>

        <div className="config-field">
          <label className="config-label">探测提示词</label>
          <textarea
            className="config-textarea"
            rows={3}
            value={config.readyProbePrompt}
            onChange={(e) => updateField("readyProbePrompt", e.target.value)}
            placeholder={defaults.readyProbePrompt}
            maxLength={500}
          />
          {keywordWarning && (
            <span className="config-warning">
              警告：探测提示词中未包含关键词 "{config.readyKeyword}"，CLI 可能无法返回正确的就绪响应
            </span>
          )}
        </div>

        <div className="config-field">
          <label className="config-label">就绪超时（秒）</label>
          <input
            className="config-input config-number"
            type="number"
            min={5}
            max={300}
            step={1}
            value={config.readyTimeoutMs / 1000}
            onChange={(e) =>
              updateField("readyTimeoutMs", Math.round(Number(e.target.value) * 1000))
            }
          />
          <span className="config-hint">
            等待 CLI 就绪的最长时间（{config.readyTimeoutMs / 1000}s）
          </span>
        </div>
      </div>

      {/* Section 2: System Prompt */}
      <div className="config-section">
        <h2 className="config-section-title">系统提示词</h2>
        <div className="config-field">
          <label className="config-label">系统提示词内容</label>
          <textarea
            className="config-textarea config-textarea-lg"
            rows={7}
            value={config.systemPrompt}
            onChange={(e) => updateField("systemPrompt", e.target.value)}
            placeholder="可选。将在初始问题前添加，作为对各 CLI 的指导说明。例如：请用中文回答，聚焦于代码架构分析..."
            maxLength={10000}
          />
          <span className="config-hint">
            可选。将在初始问题前注入，格式为 [系统指示]...
            [问题]...。留空则不注入。
          </span>
        </div>
      </div>

      {/* Section 3: Discussion Template */}
      <div className="config-section">
        <h2 className="config-section-title">讨论模板</h2>
        <div className="config-field">
          <label className="config-label">Markdown 模板内容</label>
          <textarea
            className="config-textarea config-textarea-xl config-mono"
            rows={18}
            value={config.discussionTemplate}
            onChange={(e) => updateField("discussionTemplate", e.target.value)}
            maxLength={100000}
          />
          <span className="config-hint">
            工作区创建时写入的讨论模板文件（Markdown 格式）
          </span>
        </div>
      </div>

      {/* Section 4: Workflow Timeouts */}
      <div className="config-section">
        <h2 className="config-section-title">工作流超时设置</h2>
        <div className="config-field-row">
          <div className="config-field">
            <label className="config-label">空闲完成超时（秒）</label>
            <input
              className="config-input config-number"
              type="number"
              min={5}
              max={120}
              step={1}
              value={config.idleCompleteMs / 1000}
              onChange={(e) =>
                updateField("idleCompleteMs", Math.round(Number(e.target.value) * 1000))
              }
            />
            <span className="config-hint">
              无 stdout 输出多久后视为完成（{config.idleCompleteMs / 1000}s）
            </span>
          </div>
          <div className="config-field">
            <label className="config-label">问题硬超时（秒）</label>
            <input
              className="config-input config-number"
              type="number"
              min={30}
              max={600}
              step={1}
              value={config.questionTimeoutMs / 1000}
              onChange={(e) =>
                updateField(
                  "questionTimeoutMs",
                  Math.round(Number(e.target.value) * 1000)
                )
              }
            />
            <span className="config-hint">
              单个 CLI 回答的最长等待时间（{config.questionTimeoutMs / 1000}s）
            </span>
          </div>
        </div>
      </div>

      {/* Section 5: Discussion Settings */}
      <div className="config-section">
        <h2 className="config-section-title">讨论设置</h2>
        <div className="config-field-row">
          <div className="config-field">
            <label className="config-label">最大讨论轮数</label>
            <input
              className="config-input config-number"
              type="number"
              min={1}
              max={10}
              step={1}
              value={config.discussionRounds}
              onChange={(e) =>
                updateField("discussionRounds", Math.round(Number(e.target.value)))
              }
            />
            <span className="config-hint">
              AI动态决定是否继续，此为最大上限（1-10轮）
            </span>
          </div>
          <div className="config-field">
            <label className="config-label">单次发言超时（秒）</label>
            <input
              className="config-input config-number"
              type="number"
              min={30}
              max={600}
              step={1}
              value={config.discussionTurnTimeoutMs / 1000}
              onChange={(e) =>
                updateField(
                  "discussionTurnTimeoutMs",
                  Math.round(Number(e.target.value) * 1000)
                )
              }
            />
            <span className="config-hint">
              每位专家单次发言的最长等待时间（{config.discussionTurnTimeoutMs / 1000}s）
            </span>
          </div>
        </div>
        <div className="config-field" style={{ marginTop: 12 }}>
          <label className="config-label" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={config.enableConsensusSummary}
              onChange={(e) => updateField("enableConsensusSummary", e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            生成共识总结
          </label>
          <span className="config-hint">
            讨论结束后由话题主持人自动生成共识总结
          </span>
        </div>
      </div>

      {/* Actions bar */}
      <div className="config-actions">
        <div className="config-actions-left">
          <button
            className="config-btn config-btn-primary"
            onClick={handleSave}
            disabled={saveStatus === "saving"}
          >
            {saveStatus === "saving" ? "保存中..." : "保存配置"}
          </button>
          <button
            className={`config-btn config-btn-secondary ${confirmReset ? "config-btn-danger" : ""}`}
            onClick={handleReset}
          >
            {confirmReset ? "确认重置？" : "重置为默认值"}
          </button>
          {confirmReset && (
            <button
              className="config-btn config-btn-secondary"
              onClick={() => setConfirmReset(false)}
            >
              取消
            </button>
          )}
        </div>
        <div className="config-actions-right">
          {saveStatus === "saved" && (
            <span className="config-save-status config-save-ok">已保存</span>
          )}
          {saveStatus === "error" && (
            <span className="config-save-status config-save-err">
              {errorMsg || "保存失败"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
