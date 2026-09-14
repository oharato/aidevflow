import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { AgentDispatcher } from "../../src/daemon/dispatcher.js";
import { PermissionGuard } from "../../src/workflow/permission.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../../src/agents/types.js";
import type { GitWorktreeManager, WorktreeTarget } from "../../src/git/worktree.js";
import type { GitHubService } from "../../src/git/github.js";
import type { BacklogClient } from "../../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, UpdateIssueParams } from "../../src/backlog/types.js";

const execAsync = promisify(exec);

class MockDispatcherRunner implements IAgentRunner {
  private handler: (role: AgentRole) => Promise<AgentResult> | AgentResult;

  constructor(handler: (role: AgentRole) => Promise<AgentResult> | AgentResult) {
    this.handler = handler;
  }

  setHandler(handler: (role: AgentRole) => Promise<AgentResult> | AgentResult) {
    this.handler = handler;
  }

  async run(role: AgentRole): Promise<AgentResult> {
    return this.handler(role);
  }
}

describe("AgentDispatcher & 宣言的ワークフローエンジン統合", () => {
  let tempRepoDir: string;
  let lastUpdatedParams: UpdateIssueParams = {};
  let lastPostedComment = "";

  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 100, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 100, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  beforeEach(async () => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-disp-wf-"));
    // 一時Gitリポジトリを初期化
    await execAsync("git init", { cwd: tempRepoDir });
    await execAsync("git config user.name 'Test User'", { cwd: tempRepoDir });
    await execAsync("git config user.email 'test@example.com'", { cwd: tempRepoDir });
    fs.writeFileSync(path.join(tempRepoDir, "README.md"), "# Initial\n");
    await execAsync("git add . && git commit -m 'Initial commit'", { cwd: tempRepoDir });

    lastUpdatedParams = {};
    lastPostedComment = "";
  });

  afterEach(() => {
    if (fs.existsSync(tempRepoDir)) {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  const mockBacklog = {
    getComments: async () => [],
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssue: async (_key: string, params: UpdateIssueParams) => {
      lastUpdatedParams = { ...params };
      if (params.comment) lastPostedComment = params.comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedParams = { statusId, comment };
      if (comment) lastPostedComment = comment;
      return { id: 1 };
    },
  } as unknown as BacklogClient;

  const createMockWorktreeManager = (worktreePath: string) =>
    ({
      getWorktreesDir: () => path.dirname(worktreePath),
      ensureWorktrees: async (_repoPaths: string[], issueKey: string): Promise<WorktreeTarget[]> => [
        {
          repoName: "test-repo",
          repoPath: worktreePath,
          worktreeDir: worktreePath,
          branch: issueKey,
        },
      ],
    } as unknown as GitWorktreeManager);

  const mockGithubService = {
    ensurePullRequests: async () => [
      { repoName: "test-repo", prUrl: "https://github.com/org/test-repo/pull/10", isExisting: false },
    ],
  } as unknown as GitHubService;

  it("決定キーワード（<!-- DECISION: PLANNED -->）により spec-writer から spec-reviewer へ正しく遷移すること", async () => {
    const runner = new MockDispatcherRunner(() => ({
      role: "spec-writer",
      success: true,
      summary: "仕様策定完了",
      output: "仕様を策定しました。\n\n<!-- DECISION: PLANNED -->",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      tempRepoDir,
      false,
      undefined,
      createMockWorktreeManager(tempRepoDir),
      mockGithubService
    );

    const issue: BacklogIssue = {
      id: 1,
      projectId: 100,
      issueKey: "STUDY-50",
      summary: "決済APIの追加",
      description: `リポジトリ: ${tempRepoDir}`,
      status: { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
      updated: new Date().toISOString(),
    };

    const res = await dispatcher.processIssue(issue, standardStatuses);

    expect(res.handled).toBe(true);
    expect(res.newSummary).toContain("[設計レビュー中]");
    expect(lastUpdatedParams.summary).toContain("[設計レビュー中]");
    expect(lastUpdatedParams.statusId).toBe(2); // 処理中
  });

  it("レビュアー (spec-reviewer) 実行中に不正な未コミットファイルが作成された場合、PermissionGuard が自動ロールバックし Backlog コメントに注意書きが含まれること", async () => {
    const runner = new MockDispatcherRunner(async () => {
      // レビュアーが不正にファイルを変更・追加した状況をシミュレート
      fs.writeFileSync(path.join(tempRepoDir, "tampered.js"), "console.log('tampered');");
      return {
        role: "spec-reviewer",
        success: true,
        summary: "レビュー完了",
        output: "レビュー承認しました。\n\n<!-- DECISION: APPROVED -->",
      };
    });

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      tempRepoDir,
      false,
      undefined,
      createMockWorktreeManager(tempRepoDir),
      mockGithubService
    );

    const issue: BacklogIssue = {
      id: 2,
      projectId: 100,
      issueKey: "STUDY-51",
      summary: "[設計レビュー中] 決済APIの追加",
      description: `リポジトリ: ${tempRepoDir}`,
      status: { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
      updated: new Date().toISOString(),
    };

    const res = await dispatcher.processIssue(issue, standardStatuses);

    expect(res.handled).toBe(true);
    // 不正ファイルが自動で破棄（clean）されていること
    expect(fs.existsSync(path.join(tempRepoDir, "tampered.js"))).toBe(false);

    // Backlog コメントに PermissionGuard の注意書きが含まれていること
    expect(lastPostedComment).toContain("【権限制御 (PermissionGuard)】");
    expect(lastPostedComment).toContain("安全にロールバック・破棄しました");
  });

  it("Fastモードのチケットで developer -> code-reviewer 統合レビューを経て全工程完了へ遷移すること", async () => {
    const runner = new MockDispatcherRunner(() => ({
      role: "code-reviewer",
      success: true,
      summary: "統合レビュー承認",
      output: "Fastモード統合レビュー完了、問題なし。\n\n<!-- DECISION: APPROVED -->",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      tempRepoDir,
      false,
      undefined,
      createMockWorktreeManager(tempRepoDir),
      mockGithubService
    );

    const issue: BacklogIssue = {
      id: 3,
      projectId: 100,
      issueKey: "STUDY-52",
      summary: "[技術レビュー中] [fast] 軽微なバグ修正",
      description: `リポジトリ: ${tempRepoDir}`,
      status: { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
      updated: new Date().toISOString(),
    };

    const res = await dispatcher.processIssue(issue, standardStatuses);

    expect(res.handled).toBe(true);
    expect(res.newSummary).toContain("[要件レビュー完了]");
    expect(lastUpdatedParams.statusId).toBe(3); // 処理済み（全工程完了）
  });
});
