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

export interface AgentResult {
  role: AgentRole;
  success: boolean;
  summary: string;
  nextStatusName?: string;
  isRejection?: boolean;
  output: string;
}

export interface IAgentRunner {
  run(role: AgentRole, context: AgentContext): Promise<AgentResult>;
}
