export type AgentRole = "spec-writer" | "spec-reviewer" | "developer" | "code-reviewer" | "requirement-reviewer";

export interface AgentContext {
  issueKey: string;
  issueSummary: string;
  issueDescription: string;
  recentComments: string[];
  workDir: string;
  isInvestigation?: boolean;
  isFastMode?: boolean;
}

export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface CumulativeTokenStats {
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
}

export interface QuotaBucketInfo {
  id: string;
  name: string;
  window: string;
  remainingFraction: number;
  remainingPercentage: number;
  resetTime: string;
}

export interface QuotaGroupInfo {
  name: string;
  buckets: QuotaBucketInfo[];
}

export interface QuotaUsageInfo {
  groups: QuotaGroupInfo[];
  summaryText: string;
}

export interface AgentResult {
  role: AgentRole;
  success: boolean;
  summary: string;
  nextStatusName?: string;
  isRejection?: boolean;
  output: string;
  usage?: AgentTokenUsage;
  durationSeconds?: number;
  quotaUsage?: QuotaUsageInfo;
}

export interface QuotaProbeResult {
  recovered: boolean;
  resetDurationSec?: number | null;
  resetDurationText?: string;
  errorMessage?: string;
  quotaUsage?: QuotaUsageInfo;
}

export interface IAgentRunner {
  run(role: AgentRole, context: AgentContext): Promise<AgentResult>;
  probeQuotaRecovery?(): Promise<QuotaProbeResult>;
  getQuotaUsage?(): Promise<QuotaUsageInfo | null>;
}
