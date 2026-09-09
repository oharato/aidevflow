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
  pollIntervalSec: number;
  dryRun: boolean;
  agentRunner: "agy" | "claude" | "mock";
  agentWorkDir: string;
  defaultRepoPath?: string;
  aidevflowHome: string;
  maxRejectionCount: number;
  agyEffort?: "low" | "medium" | "high";
  logFilePath: string;
  targetIssueType?: string;
  targetCategory?: string;
  requireAiTag?: boolean;
  agentTimeout: string;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.BACKLOG_API_KEY ?? "";
  const spaceId = process.env.BACKLOG_SPACE_ID || "ohchans";
  const domain = process.env.BACKLOG_DOMAIN || "backlog.jp";
  const projectKey = process.env.BACKLOG_PROJECT_KEY || "STUDY";
  const issueKey = process.env.BACKLOG_ISSUE_KEY || undefined;
  const pollIntervalSec = Number(process.env.POLL_INTERVAL_SEC) || 10;
  const dryRun = process.env.DRY_RUN === "true";
  const agentRunner = (process.env.AGENT_RUNNER || "agy") as AppConfig["agentRunner"];
  const agentWorkDir = process.env.AGENT_WORKDIR || process.cwd();
  const defaultRepoPath = process.env.DEFAULT_REPO_PATH || agentWorkDir;
  const aidevflowHome = process.env.AIDEVFLOW_HOME || path.join(os.homedir(), "aidevflow");
  const maxRejectionCount = Number(process.env.MAX_REJECTION_COUNT) || 3;
  const agyEffort = (process.env.AGY_EFFORT || "medium") as AppConfig["agyEffort"];
  const logFilePath = process.env.LOG_FILE_PATH || "logs/aidevflow.jsonl";
  const targetIssueType = process.env.TARGET_ISSUE_TYPE || undefined;
  const targetCategory = process.env.TARGET_CATEGORY || undefined;
  const requireAiTag = process.env.REQUIRE_AI_TAG === "true";

  return {
    backlogSpaceId: spaceId,
    backlogDomain: domain,
    backlogApiKey: apiKey,
    backlogProjectKey: projectKey,
    backlogIssueKey: issueKey,
    pollIntervalSec,
    dryRun,
    agentRunner,
    agentWorkDir,
    defaultRepoPath,
    aidevflowHome,
    maxRejectionCount,
    agyEffort,
    logFilePath,
    targetIssueType,
    targetCategory,
    requireAiTag,
    agentTimeout: process.env.AGENT_TIMEOUT || "20m",
  };
}
