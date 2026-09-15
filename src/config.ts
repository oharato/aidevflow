import path from "path";
import os from "os";

// Node.js LTS (v24+) 組み込みの環境変数ファイル読み込み
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env が存在しない場合は環境変数をそのまま利用
  }
}

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
  maxRejectionCount: number;
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
}

/**
 * 列挙型環境変数の検証。typo を黙って既定値（Backlog / agy）に落とさず起動時に失敗させる。
 */
function validateEnum<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const normalized = value.trim().toLowerCase();
  const hit = allowed.find((a) => a === normalized);
  if (!hit) {
    throw new Error(
      `【設定エラー】${name}="${value}" は無効です。指定可能な値: ${allowed.join(" / ")}`
    );
  }
  return hit;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.BACKLOG_API_KEY ?? "";
  const spaceId = process.env.BACKLOG_SPACE_ID || "ohchans";
  const domain = process.env.BACKLOG_DOMAIN || "backlog.jp";
  const projectKey = process.env.BACKLOG_PROJECT_KEY || "STUDY";
  const issueKey = process.env.BACKLOG_ISSUE_KEY || undefined;
  const trackerType = validateEnum(
    "TRACKER_TYPE",
    process.env.TRACKER_TYPE || process.env.BTS_TYPE || "backlog",
    ["backlog", "mock", "github"] as const
  );
  const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC) || 10;
  const dryRun = process.env.DRY_RUN === "true";
  const agentRunner = validateEnum(
    "AGENT_RUNNER",
    process.env.AGENT_RUNNER || "agy",
    ["agy", "claude", "mock"] as const
  );
  const claudeModel = process.env.CLAUDE_MODEL || undefined;
  const agentWorkDir = process.env.AGENT_WORKDIR || process.cwd();
  const defaultRepoPath = process.env.DEFAULT_REPO_PATH || agentWorkDir;
  const aidevflowHome = process.env.AIDEVFLOW_HOME || path.join(os.homedir(), "aidevflow");
  const maxRejectionCount = Number(process.env.MAX_REJECTION_COUNT) || 3;
  const agyEffort = (process.env.AGY_EFFORT || "low") as AppConfig["agyEffort"];
  const agyModel = process.env.AGY_MODEL || "gemini-3.8-flash-high";
  const agyReviewModel = process.env.AGY_REVIEW_MODEL || undefined;
  const logFilePath = process.env.LOG_FILE_PATH || "logs/aidevflow.jsonl";
  const targetIssueType = process.env.TARGET_ISSUE_TYPE || undefined;
  const targetCategory = process.env.TARGET_CATEGORY || undefined;
  const requireAiTag = process.env.REQUIRE_AI_TAG === "true";
  const onlyAssignedToMe = process.env.ONLY_ASSIGNED_TO_ME === "true";
  const rawConcurrency = process.env.MAX_CONCURRENCY || process.env.AIDEVFLOW_CONCURRENCY;
  const maxConcurrency = Math.max(1, rawConcurrency ? Number(rawConcurrency) || 2 : 2);
  const quotaLockFilePath = process.env.QUOTA_LOCK_FILE_PATH || ".aidevflow.quota.lock";
  const quotaProbeIntervalSec = Number(process.env.QUOTA_PROBE_INTERVAL_SEC) || 300;
  const quotaAutoResume = process.env.QUOTA_AUTO_RESUME !== "false";
  const requireHumanSpecApproval = process.env.REQUIRE_HUMAN_SPEC_APPROVAL === "true";

  return {
    backlogSpaceId: spaceId,
    backlogDomain: domain,
    backlogApiKey: apiKey,
    backlogProjectKey: projectKey,
    backlogIssueKey: issueKey,
    trackerType,
    pollIntervalSec,
    dryRun,
    agentRunner,
    agentWorkDir,
    defaultRepoPath,
    aidevflowHome,
    maxRejectionCount,
    agyEffort,
    agyModel,
    agyReviewModel,
    claudeModel,
    logFilePath,
    targetIssueType,
    targetCategory,
    requireAiTag,
    onlyAssignedToMe,
    agentTimeout: process.env.AGENT_TIMEOUT || "20m",
    maxConcurrency,
    quotaLockFilePath,
    quotaProbeIntervalSec,
    quotaAutoResume,
    requireHumanSpecApproval,
  };
}
