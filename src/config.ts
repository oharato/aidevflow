import fs from "fs";
import path from "path";
import os from "os";
import YAML from "yaml";

/**
 * 設定の読み込み優先順位（後勝ち）:
 *   1. コード内の既定値
 *   2. config.yml        … チームの共通設定（Git にコミット。秘密情報・個人差のある値は書かない）
 *   3. config.local.yml  … 個人・マシン固有の設定（.gitignore 対象。スペースID / プロジェクトキー / 配置パス等）
 *   4. 環境変数          … 一時的な上書き（DRY_RUN=true pnpm start 等）と systemd EnvironmentFile 用
 *
 * 秘密情報（API キー）は .env にだけ置く。.env は起動時に process.env へ読み込まれる。
 */

export interface AppConfig {
  backlogSpaceId: string;
  backlogDomain: string;
  backlogApiKey: string;
  backlogProjectKey: string;
  backlogIssueKey?: string;
  trackerType: "backlog" | "mock" | "github";
  pollIntervalSec: number;
  dryRun: boolean;
  agentRunner: "agy" | "claude" | "mock";
  agentWorkDir: string;
  defaultRepoPath?: string;
  aidevflowHome: string;
  workflowsDir?: string;
  maxRejectionCount: number;
  maxConsecutiveFailures: number;
  agyEffort?: "low" | "medium" | "high";
  agyModel?: string;
  agyReviewModel?: string;
  /** AGENT_RUNNER=claude 時に claude CLI へ渡すモデル名 (未指定なら CLI 既定) */
  claudeModel?: string;
  logFilePath: string;
  targetIssueType?: string;
  targetCategory?: string;
  requireAiTag?: boolean;
  /** 個人用デーモン運用: 担当者が自分（API キー所有者）のチケットのみ処理する */
  onlyAssignedToMe?: boolean;
  agentTimeout: string;
  maxConcurrency: number;
  quotaLockFilePath: string;
  quotaProbeIntervalSec: number;
  quotaAutoResume: boolean;
  requireHumanSpecApproval: boolean;
  cleanupIntervalMinutes: number;
  /** 実際に読み込まれた設定ファイル一覧（起動ログ用） */
  loadedFiles: string[];
}

export interface LoadConfigOptions {
  /** config.yml / config.local.yml / .env を探すディレクトリ（既定: カレントディレクトリ） */
  baseDir?: string;
  /** 環境変数による上書きを無効にする（テスト用） */
  ignoreEnv?: boolean;
}

type Raw = Record<string, unknown>;

/**
 * 列挙型設定値の検証。typo を黙って既定値（Backlog / agy）に落とさず起動時に失敗させる。
 */
function validateEnum<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const normalized = String(value).trim().toLowerCase();
  const hit = allowed.find((a) => a === normalized);
  if (!hit) {
    throw new Error(
      `【設定エラー】${name}="${value}" は無効です。指定可能な値: ${allowed.join(" / ")}`
    );
  }
  return hit;
}

function readYamlIfExists(filePath: string): Raw | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(text);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`【設定エラー】${filePath} はキーと値のマップである必要があります`);
  }
  return parsed as Raw;
}

function isPlainObject(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** ネストしたマップを深くマージする（後勝ち） */
function deepMerge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

function getPath(obj: Raw, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cur, key) => (isPlainObject(cur) ? cur[key] : undefined), obj);
}

function loadDotEnv(baseDir: string): string | null {
  const envPath = path.join(baseDir, ".env");
  if (!fs.existsSync(envPath)) return null;
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
      return envPath;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 「設定値の取り出し」ヘルパー: 環境変数 → YAML → 既定値
 */
function makeResolver(merged: Raw, ignoreEnv: boolean) {
  const env = (name: string): string | undefined => {
    if (ignoreEnv) return undefined;
    const v = process.env[name];
    return v === undefined || v === "" ? undefined : v;
  };

  return {
    str(yamlKey: string, envName: string | null, fallback: string): string {
      const e = envName ? env(envName) : undefined;
      if (e !== undefined) return e;
      const y = getPath(merged, yamlKey);
      return y === undefined || y === null || y === "" ? fallback : String(y);
    },
    optStr(yamlKey: string, envName: string | null): string | undefined {
      const e = envName ? env(envName) : undefined;
      if (e !== undefined) return e;
      const y = getPath(merged, yamlKey);
      return y === undefined || y === null || y === "" ? undefined : String(y);
    },
    num(yamlKey: string, envName: string | null, fallback: number): number {
      const e = envName ? env(envName) : undefined;
      const raw = e !== undefined ? e : getPath(merged, yamlKey);
      const n = Number(raw);
      return raw === undefined || raw === null || raw === "" || Number.isNaN(n) ? fallback : n;
    },
    bool(yamlKey: string, envName: string | null, fallback: boolean): boolean {
      const e = envName ? env(envName) : undefined;
      if (e !== undefined) return e.toLowerCase() === "true";
      const y = getPath(merged, yamlKey);
      if (typeof y === "boolean") return y;
      if (typeof y === "string") return y.toLowerCase() === "true";
      return fallback;
    },
    secret(envName: string): string {
      return process.env[envName] ?? "";
    },
  };
}

/** ~ 始まりのパスをホームディレクトリに展開する（YAML 側の記述を許容） */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const baseDir = options.baseDir || process.cwd();
  const ignoreEnv = Boolean(options.ignoreEnv);
  const loadedFiles: string[] = [];

  // 1. 秘密情報 (.env) を環境変数へ
  if (!ignoreEnv) {
    const envFile = loadDotEnv(baseDir);
    if (envFile) loadedFiles.push(envFile);
  }

  // 2. config.yml → 3. config.local.yml
  let merged: Raw = {};
  for (const name of ["config.yml", "config.local.yml"]) {
    const p = path.join(baseDir, name);
    const raw = readYamlIfExists(p);
    if (raw) {
      merged = deepMerge(merged, raw);
      loadedFiles.push(p);
    }
  }

  const r = makeResolver(merged, ignoreEnv);

  // --- tracker ---
  const trackerType = validateEnum(
    "tracker.type (TRACKER_TYPE)",
    r.str("tracker.type", "TRACKER_TYPE", "backlog"),
    ["backlog", "mock", "github"] as const
  );
  const backlogSpaceId = r.str("tracker.backlog.space_id", "BACKLOG_SPACE_ID", "");
  const backlogDomain = r.str("tracker.backlog.domain", "BACKLOG_DOMAIN", "backlog.jp");
  const backlogProjectKey = r.str("tracker.backlog.project_key", "BACKLOG_PROJECT_KEY", "");
  const backlogIssueKey = r.optStr("tracker.backlog.issue_key", "BACKLOG_ISSUE_KEY");
  const backlogApiKey = r.secret("BACKLOG_API_KEY");

  if (trackerType === "backlog") {
    const missing: string[] = [];
    if (!backlogSpaceId) missing.push("tracker.backlog.space_id (config.local.yml)");
    if (!backlogProjectKey) missing.push("tracker.backlog.project_key (config.local.yml)");
    if (!backlogApiKey) missing.push("BACKLOG_API_KEY (.env)");
    if (missing.length > 0) {
      throw new Error(
        `【設定エラー】Backlog 接続に必要な設定が不足しています: ${missing.join(", ")}\n` +
          `  config.local.yml.example を config.local.yml にコピーして値を埋め、.env に BACKLOG_API_KEY を設定してください。`
      );
    }
  }

  // --- agent ---
  const agentRunner = validateEnum(
    "agent.runner (AGENT_RUNNER)",
    r.str("agent.runner", "AGENT_RUNNER", "claude"),
    ["agy", "claude", "mock"] as const
  );
  const agentTimeout = r.str("agent.timeout", "AGENT_TIMEOUT", "20m");
  const agentWorkDir = expandHome(r.str("agent.work_dir", "AGENT_WORKDIR", process.cwd()));
  const claudeModel = r.optStr("agent.claude.model", "CLAUDE_MODEL");
  const agyModel = r.str("agent.agy.model", "AGY_MODEL", "gemini-3.8-flash-high");
  const agyReviewModel = r.optStr("agent.agy.review_model", "AGY_REVIEW_MODEL");
  const agyEffort = validateEnum(
    "agent.agy.effort (AGY_EFFORT)",
    r.str("agent.agy.effort", "AGY_EFFORT", "low"),
    ["low", "medium", "high"] as const
  );

  // --- paths ---
  const aidevflowHome = expandHome(
    r.str("paths.home", "AIDEVFLOW_HOME", path.join(os.homedir(), "aidevflow"))
  );
  const defaultRepoPathRaw = r.optStr("paths.default_repo_path", "DEFAULT_REPO_PATH");
  const defaultRepoPath = defaultRepoPathRaw ? expandHome(defaultRepoPathRaw) : undefined;
  const workflowsDir = r.optStr("paths.workflows_dir", "AIDEVFLOW_WORKFLOWS_DIR");

  // --- daemon ---
  const pollIntervalSec = r.num("daemon.poll_interval_sec", "POLL_INTERVAL_SEC", 10);
  const maxConcurrency = Math.max(1, r.num("daemon.max_concurrency", "MAX_CONCURRENCY", 2));
  const maxRejectionCount = r.num("daemon.max_rejection_count", "MAX_REJECTION_COUNT", 3);
  const maxConsecutiveFailures = Math.max(1, r.num("daemon.max_consecutive_failures", "MAX_CONSECUTIVE_FAILURES", 5));
  const requireHumanSpecApproval = r.bool("daemon.require_human_spec_approval", "REQUIRE_HUMAN_SPEC_APPROVAL", false);
  const dryRun = r.bool("daemon.dry_run", "DRY_RUN", false);
  const logFilePath = r.str("daemon.log_file_path", "LOG_FILE_PATH", "logs/aidevflow.jsonl");

  // --- filter ---
  const onlyAssignedToMe = r.bool("tracker.filter.only_assigned_to_me", "ONLY_ASSIGNED_TO_ME", false);
  const targetIssueType = r.optStr("tracker.filter.target_issue_type", "TARGET_ISSUE_TYPE");
  const targetCategory = r.optStr("tracker.filter.target_category", "TARGET_CATEGORY");
  const requireAiTag = r.bool("tracker.filter.require_ai_tag", "REQUIRE_AI_TAG", false);

  // --- quota / cleanup ---
  const quotaLockFilePath = r.str("quota.lock_file_path", "QUOTA_LOCK_FILE_PATH", ".aidevflow.quota.lock");
  const quotaProbeIntervalSec = r.num("quota.probe_interval_sec", "QUOTA_PROBE_INTERVAL_SEC", 300);
  const quotaAutoResume = r.bool("quota.auto_resume", "QUOTA_AUTO_RESUME", true);
  const cleanupIntervalMinutes = Math.max(1, r.num("cleanup.interval_minutes", "CLEANUP_INTERVAL_MINUTES", 30));

  return {
    backlogSpaceId,
    backlogDomain,
    backlogApiKey,
    backlogProjectKey,
    backlogIssueKey,
    trackerType,
    pollIntervalSec,
    dryRun,
    agentRunner,
    agentWorkDir,
    defaultRepoPath,
    aidevflowHome,
    workflowsDir,
    maxRejectionCount,
    maxConsecutiveFailures,
    agyEffort,
    agyModel,
    agyReviewModel,
    claudeModel,
    logFilePath,
    targetIssueType,
    targetCategory,
    requireAiTag,
    onlyAssignedToMe,
    agentTimeout,
    maxConcurrency,
    quotaLockFilePath,
    quotaProbeIntervalSec,
    quotaAutoResume,
    requireHumanSpecApproval,
    cleanupIntervalMinutes,
    loadedFiles,
  };
}
