import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Config interface ----

export interface UltraPlanConfig {
  readyKeyword: string;        // Default: "ULTRAPLAN_READY"
  readyProbePrompt: string;    // Default: readiness probe prompt text
  readyTimeoutMs: number;      // Default: 60000
  systemPrompt: string;        // Default: "" (empty = no injection)
  discussionTemplate: string;  // Default: from files/ExpertReviewTemplate_v4.md
  idleCompleteMs: number;      // Default: 20000
  questionTimeoutMs: number;   // Default: 300000
  discussionRounds: number;          // Max rounds cap: default 5 (1-10)
  discussionTurnTimeoutMs: number;   // Default: 300000 (30000-600000)
  enableConsensusSummary: boolean;   // Default: true
  enablePlanGeneration: boolean;     // Default: true
  discussionLanguage: string;        // Default: "zh-CN"
}

// ---- File paths ----

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(serverDir, "data");
const CONFIG_FILE = path.join(DATA_DIR, "ultra-plan-config.json");
const DEFAULTS_FILE = path.join(DATA_DIR, "ultra-plan-config.defaults.json");
const TEMPLATE_FILE = path.join(DATA_DIR, "discussion-template.default.md");

// ---- Hardcoded fallbacks (only used when external default files are missing) ----

const FALLBACK_DEFAULTS: Omit<UltraPlanConfig, "discussionTemplate"> = {
  readyKeyword: "ULTRAPLAN_READY",
  readyProbePrompt: "This is a system readiness check. Reply with exactly the word ULTRAPLAN_READY and nothing else.",
  readyTimeoutMs: 60_000,
  systemPrompt: "",
  idleCompleteMs: 20_000,
  questionTimeoutMs: 300_000,
  discussionRounds: 5,
  discussionTurnTimeoutMs: 300_000,
  enableConsensusSummary: true,
  enablePlanGeneration: true,
  discussionLanguage: "zh-CN",
};

const FALLBACK_TEMPLATE = "# Discussion Template\n\n> Template file not found. Please restore server/data/discussion-template.default.md\n";

// ---- Defaults (read from external files) ----

/**
 * Load default values from external files:
 *   - server/data/ultra-plan-config.defaults.json  → simple config fields
 *   - files/ExpertReviewTemplate_v4.md             → discussion template
 *
 * Falls back to hardcoded constants only when files are missing/corrupted.
 */
export function getDefaults(): UltraPlanConfig {
  // 1) Read defaults JSON
  let fileDefaults: Partial<Omit<UltraPlanConfig, "discussionTemplate">> = {};
  try {
    if (fs.existsSync(DEFAULTS_FILE)) {
      const raw = fs.readFileSync(DEFAULTS_FILE, "utf8");
      fileDefaults = JSON.parse(raw);
      console.log(`[config] Defaults loaded from ${DEFAULTS_FILE}`);
    } else {
      console.warn(`[config] Defaults file not found at ${DEFAULTS_FILE}, using hardcoded fallbacks`);
    }
  } catch (e) {
    console.warn(`[config] Failed to parse defaults file, using hardcoded fallbacks:`, e);
  }

  // 2) Read discussion template from .md file
  let discussionTemplate = FALLBACK_TEMPLATE;
  try {
    if (fs.existsSync(TEMPLATE_FILE)) {
      discussionTemplate = fs.readFileSync(TEMPLATE_FILE, "utf8");
      console.log(`[config] Discussion template loaded from ${TEMPLATE_FILE}`);
    } else {
      console.warn(`[config] Template file not found at ${TEMPLATE_FILE}, using fallback`);
    }
  } catch (e) {
    console.warn(`[config] Failed to read template file, using fallback:`, e);
  }

  // 3) Merge: file values > hardcoded fallbacks
  return {
    readyKeyword:
      typeof fileDefaults.readyKeyword === "string" && fileDefaults.readyKeyword
        ? fileDefaults.readyKeyword
        : FALLBACK_DEFAULTS.readyKeyword,
    readyProbePrompt:
      typeof fileDefaults.readyProbePrompt === "string" && fileDefaults.readyProbePrompt
        ? fileDefaults.readyProbePrompt
        : FALLBACK_DEFAULTS.readyProbePrompt,
    readyTimeoutMs:
      typeof fileDefaults.readyTimeoutMs === "number"
        ? fileDefaults.readyTimeoutMs
        : FALLBACK_DEFAULTS.readyTimeoutMs,
    systemPrompt:
      typeof fileDefaults.systemPrompt === "string"
        ? fileDefaults.systemPrompt
        : FALLBACK_DEFAULTS.systemPrompt,
    discussionTemplate,
    idleCompleteMs:
      typeof fileDefaults.idleCompleteMs === "number"
        ? fileDefaults.idleCompleteMs
        : FALLBACK_DEFAULTS.idleCompleteMs,
    questionTimeoutMs:
      typeof fileDefaults.questionTimeoutMs === "number"
        ? fileDefaults.questionTimeoutMs
        : FALLBACK_DEFAULTS.questionTimeoutMs,
    discussionRounds:
      typeof fileDefaults.discussionRounds === "number"
        ? fileDefaults.discussionRounds
        : FALLBACK_DEFAULTS.discussionRounds,
    discussionTurnTimeoutMs:
      typeof fileDefaults.discussionTurnTimeoutMs === "number"
        ? fileDefaults.discussionTurnTimeoutMs
        : FALLBACK_DEFAULTS.discussionTurnTimeoutMs,
    enableConsensusSummary:
      typeof fileDefaults.enableConsensusSummary === "boolean"
        ? fileDefaults.enableConsensusSummary
        : FALLBACK_DEFAULTS.enableConsensusSummary,
    enablePlanGeneration:
      typeof fileDefaults.enablePlanGeneration === "boolean"
        ? fileDefaults.enablePlanGeneration
        : FALLBACK_DEFAULTS.enablePlanGeneration,
    discussionLanguage:
      typeof fileDefaults.discussionLanguage === "string" && fileDefaults.discussionLanguage
        ? fileDefaults.discussionLanguage
        : FALLBACK_DEFAULTS.discussionLanguage,
  };
}

// ---- Load user config ----

export function loadConfig(): UltraPlanConfig {
  const defaults = getDefaults();

  if (!fs.existsSync(CONFIG_FILE)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<UltraPlanConfig>;

    // Merge with defaults — missing fields are filled from defaults (forward compat)
    return {
      readyKeyword: typeof parsed.readyKeyword === "string" ? parsed.readyKeyword : defaults.readyKeyword,
      readyProbePrompt: typeof parsed.readyProbePrompt === "string" ? parsed.readyProbePrompt : defaults.readyProbePrompt,
      readyTimeoutMs: typeof parsed.readyTimeoutMs === "number" ? parsed.readyTimeoutMs : defaults.readyTimeoutMs,
      systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : defaults.systemPrompt,
      discussionTemplate: typeof parsed.discussionTemplate === "string" ? parsed.discussionTemplate : defaults.discussionTemplate,
      idleCompleteMs: typeof parsed.idleCompleteMs === "number" ? parsed.idleCompleteMs : defaults.idleCompleteMs,
      questionTimeoutMs: typeof parsed.questionTimeoutMs === "number" ? parsed.questionTimeoutMs : defaults.questionTimeoutMs,
      discussionRounds: typeof parsed.discussionRounds === "number" ? parsed.discussionRounds : defaults.discussionRounds,
      discussionTurnTimeoutMs: typeof parsed.discussionTurnTimeoutMs === "number" ? parsed.discussionTurnTimeoutMs : defaults.discussionTurnTimeoutMs,
      enableConsensusSummary: typeof parsed.enableConsensusSummary === "boolean" ? parsed.enableConsensusSummary : defaults.enableConsensusSummary,
      enablePlanGeneration: typeof parsed.enablePlanGeneration === "boolean" ? parsed.enablePlanGeneration : defaults.enablePlanGeneration,
      discussionLanguage: typeof parsed.discussionLanguage === "string" && parsed.discussionLanguage ? parsed.discussionLanguage : defaults.discussionLanguage,
    };
  } catch (e) {
    console.warn(`[config] Failed to parse ${CONFIG_FILE}, using defaults:`, e);
    return defaults;
  }
}

// ---- Validate config ----

export type ValidationError = { field: string; message: string };

export function validateConfig(config: UltraPlanConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // readyKeyword: non-empty, alphanumeric + underscore, max 50 chars
  if (!config.readyKeyword || config.readyKeyword.trim().length === 0) {
    errors.push({ field: "readyKeyword", message: "不能为空" });
  } else if (!/^[A-Za-z0-9_]+$/.test(config.readyKeyword)) {
    errors.push({ field: "readyKeyword", message: "仅允许字母、数字、下划线" });
  } else if (config.readyKeyword.length > 50) {
    errors.push({ field: "readyKeyword", message: "最长 50 字符" });
  }

  // readyProbePrompt: non-empty, max 500 chars
  if (!config.readyProbePrompt || config.readyProbePrompt.trim().length === 0) {
    errors.push({ field: "readyProbePrompt", message: "不能为空" });
  } else if (config.readyProbePrompt.length > 500) {
    errors.push({ field: "readyProbePrompt", message: "最长 500 字符" });
  }

  // systemPrompt: can be empty, max 10000 chars
  if (config.systemPrompt.length > 10_000) {
    errors.push({ field: "systemPrompt", message: "最长 10000 字符" });
  }

  // discussionTemplate: non-empty, max 100000 chars
  if (!config.discussionTemplate || config.discussionTemplate.trim().length === 0) {
    errors.push({ field: "discussionTemplate", message: "不能为空" });
  } else if (config.discussionTemplate.length > 100_000) {
    errors.push({ field: "discussionTemplate", message: "最长 100000 字符" });
  }

  // Timeout values: positive integers within ranges
  if (!Number.isInteger(config.readyTimeoutMs) || config.readyTimeoutMs < 5000 || config.readyTimeoutMs > 300_000) {
    errors.push({ field: "readyTimeoutMs", message: "必须为 5000-300000 的整数 (5s-300s)" });
  }
  if (!Number.isInteger(config.idleCompleteMs) || config.idleCompleteMs < 5000 || config.idleCompleteMs > 120_000) {
    errors.push({ field: "idleCompleteMs", message: "必须为 5000-120000 的整数 (5s-120s)" });
  }
  if (!Number.isInteger(config.questionTimeoutMs) || config.questionTimeoutMs < 30_000 || config.questionTimeoutMs > 600_000) {
    errors.push({ field: "questionTimeoutMs", message: "必须为 30000-600000 的整数 (30s-600s)" });
  }

  // discussionRounds: integer 1-10
  if (!Number.isInteger(config.discussionRounds) || config.discussionRounds < 1 || config.discussionRounds > 10) {
    errors.push({ field: "discussionRounds", message: "必须为 1-10 的整数" });
  }

  // discussionTurnTimeoutMs: integer 30000-600000
  if (!Number.isInteger(config.discussionTurnTimeoutMs) || config.discussionTurnTimeoutMs < 30_000 || config.discussionTurnTimeoutMs > 600_000) {
    errors.push({ field: "discussionTurnTimeoutMs", message: "必须为 30000-600000 的整数 (30s-600s)" });
  }

  // enableConsensusSummary: boolean
  if (typeof config.enableConsensusSummary !== "boolean") {
    errors.push({ field: "enableConsensusSummary", message: "必须为布尔值" });
  }

  // enablePlanGeneration: boolean
  if (typeof config.enablePlanGeneration !== "boolean") {
    errors.push({ field: "enablePlanGeneration", message: "必须为布尔值" });
  }

  // discussionLanguage: non-empty string, max 20 chars
  if (!config.discussionLanguage || config.discussionLanguage.trim().length === 0) {
    errors.push({ field: "discussionLanguage", message: "不能为空" });
  } else if (config.discussionLanguage.length > 20) {
    errors.push({ field: "discussionLanguage", message: "最长 20 字符" });
  }

  return errors;
}

// ---- Save config ----

export function saveConfig(config: UltraPlanConfig): { ok: boolean; errors?: ValidationError[] } {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log(`[config] Saved to ${CONFIG_FILE}`);
    return { ok: true };
  } catch (e) {
    console.error(`[config] Failed to save:`, e);
    return { ok: false, errors: [{ field: "_", message: `写入失败: ${e}` }] };
  }
}

// ---- Reset config ----

export function resetConfig(): UltraPlanConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log(`[config] Deleted ${CONFIG_FILE}, restored defaults`);
    }
  } catch (e) {
    console.warn(`[config] Failed to delete config file:`, e);
  }
  return getDefaults();
}
