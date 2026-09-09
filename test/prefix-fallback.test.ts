import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { BacklogPoller } from "../src/daemon/poller.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject, UpdateIssueParams } from "../src/backlog/types.js";

class MockCustomRunner implements IAgentRunner {
  private handler: (role: AgentRole) => AgentResult;

  constructor(handler: (role: AgentRole) => AgentResult) {
    this.handler = handler;
  }

  setHandler(handler: (role: AgentRole) => AgentResult) {
    this.handler = handler;
  }

  async run(role: AgentRole): Promise<AgentResult> {
    return this.handler(role);
  }
}

describe("Backlogフリープラン（標準4状態のみ）件名プレフィックスフォールバック", () => {
  const testLogPath = "logs/test-prefix-fallback.jsonl";
  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 5406, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 5406, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 5406, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 5406, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  let lastUpdatedParams: UpdateIssueParams = {};
  let lastPostedComment = "";
  let logger: JsonlLogger;

  beforeEach(() => {
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
    logger = new JsonlLogger(testLogPath);
    lastUpdatedParams = {};
    lastPostedComment = "";
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

  const mockWorktreeManager = {
    getWorktreesDir: () => "/mock/worktrees",
    ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
      return repoPaths.map((p) => ({
        repoName: "payment-service",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/payment-service`,
        branch: issueKey,
      }));
    },
  } as unknown as GitWorktreeManager;

  const mockGitHubService = {
    ensurePullRequests: async () => [
      { repoName: "payment-service", prUrl: "https://github.com/my-org/payment-service/pull/10" },
    ],
  } as unknown as GitHubService;

  const baseIssue: BacklogIssue = {
    id: 2001,
    projectId: 5406,
    issueKey: "STUDY-5",
    keyId: 5,
    issueType: { id: 1, name: "タスク" },
    summary: "決済APIリファクタリング",
    description: "リポジトリ: /mock/payment-service\n決済モジュールを修正する",
    status: standardStatuses[1], // 処理中
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-09T00:00:00Z",
    updated: "2026-09-09T00:00:00Z",
  };

  it("標準4状態のみの環境でカスタム状態モードがfalseと自動判別されること", () => {
    const runner = new MockCustomRunner(() => ({ success: true, isRejection: false, summary: "", output: "" }));
    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/repo", false, logger, mockWorktreeManager, mockGitHubService, 3);
    expect(dispatcher.isCustomStatusMode(standardStatuses)).toBe(false);
  });

  it("タグなしチケット着手でdirectorが実行され、件名が[設計レビュー中]に自動更新されること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: false,
      summary: "詳細設計完了",
      output: "API仕様策定完了。次は設計レビューです。",
    }));

    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/payment-service", false, logger, mockWorktreeManager, mockGitHubService, 3);
    const res = await dispatcher.processIssue(baseIssue, standardStatuses);

    expect(res.newSummary).toBe("[設計レビュー中] 決済APIリファクタリング");
    expect(lastUpdatedParams.summary).toBe("[設計レビュー中] 決済APIリファクタリング");
    expect(lastUpdatedParams.statusId).toBe(2);
  });

  it("設計レビュー承認により件名が[実装中]に正常更新されること", async () => {
    const curatorIssue: BacklogIssue = {
      ...baseIssue,
      summary: "[設計レビュー中] 決済APIリファクタリング",
      status: standardStatuses[1], // 処理中
    };

    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: false,
      summary: "設計LGTM",
      output: "設計書の内容を承認しました（LGTM）。次は実装です。",
    }));

    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/payment-service", false, logger, mockWorktreeManager, mockGitHubService, 3);
    const res = await dispatcher.processIssue(curatorIssue, standardStatuses);

    expect(res.newSummary).toBe("[実装中] 決済APIリファクタリング");
    expect(lastUpdatedParams.summary).toBe("[実装中] 決済APIリファクタリング");
    expect(lastUpdatedParams.statusId).toBe(2);
  });

  it("差し戻し3回で[確認待ち]かつステータスが未対応へエスカレーションされること", async () => {
    const criticIssue: BacklogIssue = {
      ...baseIssue,
      summary: "[技術レビュー中] 決済APIリファクタリング",
      status: standardStatuses[1], // 処理中
    };

    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: true,
      summary: "テスト不足",
      output: "単体テストのカバレッジ不足。",
    }));

    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/payment-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

    await dispatcher.processIssue(criticIssue, standardStatuses); // 1回目
    await dispatcher.processIssue(criticIssue, standardStatuses); // 2回目
    const resReject3 = await dispatcher.processIssue(criticIssue, standardStatuses); // 3回目 (上限到達)

    expect(resReject3.isEscalation).toBe(true);
    expect(resReject3.newSummary).toBe("[確認待ち] 決済APIリファクタリング");
    expect(lastUpdatedParams.summary).toBe("[確認待ち] 決済APIリファクタリング");
    expect(lastUpdatedParams.statusId).toBe(1); // 未対応
  });

  it("人間による「確認待ち」解除を検知し、カウンターをリセットして正常に再開されること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: true,
      summary: "指摘",
      output: "指摘",
    }));

    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/payment-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

    // 上限到達
    await dispatcher.processIssue({ ...baseIssue, summary: "[技術レビュー中] 決済APIリファクタリング" }, standardStatuses);
    await dispatcher.processIssue({ ...baseIssue, summary: "[技術レビュー中] 決済APIリファクタリング" }, standardStatuses);
    await dispatcher.processIssue({ ...baseIssue, summary: "[技術レビュー中] 決済APIリファクタリング" }, standardStatuses);
    expect(dispatcher.getRejectionCount("STUDY-5")).toBe(3);

    let currentIssueState: BacklogIssue = {
      ...baseIssue,
      summary: "[確認待ち] 決済APIリファクタリング",
      status: standardStatuses[0], // 未対応
    };

    const dummyProject: BacklogProject = {
      id: 5406,
      projectKey: "STUDY",
      name: "勉強プロジェクト",
      chartEnabled: false,
      subtaskingEnabled: false,
      projectLeaderCanEditProjectLeader: false,
      useWiki: false,
      useFileSharing: false,
      useWikiTreeView: false,
      archived: false,
    };

    const pollerBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => standardStatuses,
      getIssues: async () => [currentIssueState],
      getComments: async () => [{ createdUser: { name: "ユーザー" }, content: "カバレッジ基準を緩和します。" }],
      addComment: async (_k: string, c: string) => {
        lastPostedComment = c;
        return { id: 1 };
      },
      updateIssue: async (_k: string, p: UpdateIssueParams) => {
        lastUpdatedParams = { ...p };
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const poller = new BacklogPoller(pollerBacklog, dispatcher, "STUDY", undefined, 1, logger);
    await poller.init();
    await poller.pollOnce();

    // 人間が「[実装中]」にしてステータスを「処理中」に変更
    currentIssueState = {
      ...baseIssue,
      summary: "[実装中] 決済APIリファクタリング",
      status: standardStatuses[1], // 処理中
    };

    runner.setHandler(() => ({
      success: true,
      isRejection: false,
      summary: "実装完了",
      output: "カバレッジ対応完了。次は技術レビューです。",
    }));

    await poller.pollOnce();

    expect(dispatcher.getRejectionCount("STUDY-5")).toBe(0);
    expect(lastUpdatedParams.summary).toBe("[技術レビュー中] 決済APIリファクタリング");
  });

  it("Editor承認時に[要件レビュー完了]かつステータスが処理済み(3)に更新されること", async () => {
    const editorIssue: BacklogIssue = {
      ...baseIssue,
      summary: "[要件レビュー中] 決済APIリファクタリング",
      status: standardStatuses[1], // 処理中
    };

    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: false,
      summary: "全要件充足",
      output: "すべての要件を満たしていることを確認しました。全工程完了です。",
    }));

    const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/payment-service", false, logger, mockWorktreeManager, mockGitHubService, 3);
    const res = await dispatcher.processIssue(editorIssue, standardStatuses);

    expect(res.newSummary).toBe("[要件レビュー完了] 決済APIリファクタリング");
    expect(lastUpdatedParams.summary).toBe("[要件レビュー完了] 決済APIリファクタリング");
    expect(lastUpdatedParams.statusId).toBe(3); // 処理済み
    expect(lastPostedComment).toContain("【レビュー依頼】AIエージェントによる全工程が完了しました");
  });
});
