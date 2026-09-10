import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import { AgentDispatcher, hasHumanEscalationRequest } from "../src/daemon/dispatcher.js";
import { checkIsRejection } from "../src/agents/runner.js";
import { BacklogPoller } from "../src/daemon/poller.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject } from "../src/backlog/types.js";

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

describe("差し戻し無限ループ防止 & 人間確認エスカレーション", () => {
  const testLogPath = "logs/test-loop-prevention.jsonl";
  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "詳細設計中", color: "#3b9dbd", displayOrder: 2 },
    { id: 3, projectId: 100, name: "設計レビュー中", color: "#868cb7", displayOrder: 3 },
    { id: 4, projectId: 100, name: "実装中", color: "#eda62a", displayOrder: 4 },
    { id: 5, projectId: 100, name: "技術レビュー中", color: "#b0be3c", displayOrder: 5 },
    { id: 6, projectId: 100, name: "要件レビュー中", color: "#e07b9a", displayOrder: 6 },
    { id: 7, projectId: 100, name: "確認待ち", color: "#f42858", displayOrder: 7 },
    { id: 8, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 8 },
  ];

  let lastUpdatedStatusId: number | null = null;
  let lastPostedComment = "";
  let logger: JsonlLogger;

  beforeEach(() => {
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
    logger = new JsonlLogger(testLogPath);
    lastUpdatedStatusId = null;
    lastPostedComment = "";
  });

  const mockBacklog = {
    getComments: async () => [],
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssue: async (_key: string, params: { statusId?: number; comment?: string }) => {
      if (params.statusId !== undefined) lastUpdatedStatusId = params.statusId;
      if (params.comment) lastPostedComment = params.comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedStatusId = statusId;
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
    ensurePullRequests: async () => [],
  } as unknown as GitHubService;

  const baseIssue: BacklogIssue = {
    id: 1001,
    projectId: 100,
    issueKey: "STUDY-3",
    keyId: 3,
    issueType: { id: 1, name: "タスク" },
    summary: "決済APIリファクタリング",
    description: "リポジトリ: /mock/payment-service\n決済モジュールの設計と実装",
    status: dummyStatuses[4], // 技術レビュー中 (critic)
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-09T00:00:00Z",
    updated: "2026-09-09T00:00:00Z",
  };

  it("3回差し戻しで「確認待ち」へエスカレーションされること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: true,
      summary: "レビュー指摘による差し戻し",
      output: "テストコードの網羅性が不足しています。修正してください。",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      "/mock/repo",
      false,
      logger,
      mockWorktreeManager,
      mockGitHubService,
      3
    );

    // 1回目
    const res1 = await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(res1.isEscalation).toBeFalsy();
    expect(res1.nextStatusTarget).toBe("実装");
    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(1);

    // 2回目
    const res2 = await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(res2.isEscalation).toBeFalsy();
    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(2);

    // 3回目 (上限到達)
    const res3 = await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(res3.isEscalation).toBe(true);
    expect(res3.nextStatusTarget).toBe("確認待ち");
    expect(lastUpdatedStatusId).toBe(7);
    expect(lastPostedComment).toContain("【人間への確認依頼】自律パイプラインを一時停止しました");
    expect(lastPostedComment).toContain("差し戻し上限（3回）に達しました");
  });

  it("エージェントからの明示的な確認要請で即時エスカレーションされること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: false,
      summary: "仕様の曖昧さを検出",
      output: "外部決済ゲートウェイのリトライ仕様が未定義です。【人間への確認依頼】指示をお願いします。",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      "/mock/repo",
      false,
      logger,
      mockWorktreeManager,
      mockGitHubService,
      3
    );

    const designIssue: BacklogIssue = {
      ...baseIssue,
      status: dummyStatuses[1], // 詳細設計中 (director)
    };

    const res = await dispatcher.processIssue(designIssue, dummyStatuses);
    expect(res.isEscalation).toBe(true);
    expect(res.nextStatusTarget).toBe("確認待ち");
    expect(lastPostedComment).toContain("エージェントから人間への確認要請がありました");
  });

  it("レビュー承認（LGTM）により差し戻しカウンターがリセットされること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: true,
      summary: "指摘",
      output: "指摘",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      "/mock/repo",
      false,
      logger,
      mockWorktreeManager,
      mockGitHubService,
      3
    );

    await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(1);

    // 承認 (LGTM)
    runner.setHandler(() => ({ success: true, isRejection: false, summary: "LGTM", output: "技術観点LGTM" }));
    const resApprove = await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(resApprove.isEscalation).toBeFalsy();
    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(0);
  });

  it("人間による「確認待ち」解除を検知し、カウンターをリセットして自動再開すること", async () => {
    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: true,
      summary: "指摘",
      output: "指摘",
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      "/mock/repo",
      false,
      logger,
      mockWorktreeManager,
      mockGitHubService,
      3
    );

    // 3回差し戻しで上限到達
    await dispatcher.processIssue(baseIssue, dummyStatuses);
    await dispatcher.processIssue(baseIssue, dummyStatuses);
    await dispatcher.processIssue(baseIssue, dummyStatuses);
    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(3);

    // Poller による検知
    const dummyProject: BacklogProject = {
      id: 100,
      projectKey: "STUDY",
      name: "AI検証プロジェクト",
      chartEnabled: false,
      subtaskingEnabled: false,
      projectLeaderCanEditProjectLeader: false,
      useWiki: false,
      useFileSharing: false,
      useWikiTreeView: false,
      archived: false,
    };

    let currentIssueState: BacklogIssue = {
      ...baseIssue,
      status: dummyStatuses[6], // 確認待ち
    };

    const pollerBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => [currentIssueState],
      getComments: async () => [{ createdUser: { name: "管理者" }, content: "リトライは最大3回としてください。" }],
      addComment: async (_key: string, comment: string) => {
        lastPostedComment = comment;
        return { id: 1 };
      },
      updateIssue: async (_key: string, params: { statusId?: number; comment?: string }) => {
        if (params.statusId !== undefined) lastUpdatedStatusId = params.statusId;
        return { id: 1 };
      },
      updateIssueStatus: async (_key: string, statusId: number) => {
        lastUpdatedStatusId = statusId;
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const poller = new BacklogPoller(pollerBacklog, dispatcher, "STUDY", undefined, 1, logger);
    await poller.init();
    await poller.pollOnce();

    // 人間が「実装中」に変更
    currentIssueState = {
      ...baseIssue,
      status: dummyStatuses[3], // 実装中 (artist)
    };

    runner.setHandler(() => ({
      success: true,
      isRejection: false,
      summary: "実装完了",
      output: "指示に従い実装完了。次は技術レビューです。",
    }));

    await poller.pollOnce();

    expect(dispatcher.getRejectionCount("STUDY-3")).toBe(0);

    // ログ確認
    const logContent = fs.readFileSync(testLogPath, "utf8");
    expect(logContent).toContain("human_escalation");
  });

  it("「CONFIRM_HUMANもございません」や「【人間への確認依頼】はありません」等の否定文脈ではエスカレーションされないこと", async () => {
    // 1. hasHumanEscalationRequest の単体検証
    expect(hasHumanEscalationRequest("本課題の要件定義に基づく全機能が完全に実装され、人間の判断を要するエスカレーション事項（CONFIRM_HUMAN）もございません。")).toBe(false);
    expect(hasHumanEscalationRequest("【人間への確認依頼】はありません。全工程完了です。")).toBe(false);
    expect(hasHumanEscalationRequest("CONFIRM_HUMAN: なし")).toBe(false);
    expect(hasHumanEscalationRequest("【人間への確認依頼】: 不要")).toBe(false);
    expect(hasHumanEscalationRequest("【人間への確認依頼】が必要です。指示をお願いします。")).toBe(true);
    expect(hasHumanEscalationRequest("CONFIRM_HUMAN: 外部決済仕様が未定義です")).toBe(true);

    // 2. checkIsRejection の単体検証
    expect(checkIsRejection("差し戻し事項はありません。承認します。")).toBe(false);
    expect(checkIsRejection("差し戻し: なし")).toBe(false);
    expect(checkIsRejection("リジェクト不要（LGTM）")).toBe(false);
    expect(checkIsRejection("バグがあるためartistへ差し戻します。")).toBe(true);

    // 3. STUDY-3 で発生した実際のエージェント出力（否定文脈のCONFIRM_HUMANを含むLGTM）での動作検証
    const actualEditorOutput = `### 5. 結論
本課題（STUDY-3）の要件定義に基づく全機能が完全に実装され、技術的・要件的観点の双方において基準をクリアしています。人間の判断を要するエスカレーション事項（CONFIRM_HUMAN）もございません。
**要件観点LGTM（全工程完了）** とし、本タスクの完了を承認します。プルリクエストのベースブランチへのマージが可能な状態です。`;

    const runner = new MockCustomRunner(() => ({
      success: true,
      isRejection: false,
      summary: "要件レビュー完了",
      output: actualEditorOutput,
    }));

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      runner,
      "/mock/repo",
      false,
      logger,
      mockWorktreeManager,
      mockGitHubService,
      3
    );

    const editorIssue: BacklogIssue = {
      ...baseIssue,
      status: dummyStatuses[5], // 要件レビュー中 (editor)
    };

    const res = await dispatcher.processIssue(editorIssue, dummyStatuses);
    expect(res.isEscalation).toBe(false);
    expect(res.nextStatusTarget).toBe("完了");
  });
});
