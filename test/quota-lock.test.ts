import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { QuotaLockManager, parseResetDuration } from "../src/daemon/quota-lock.js";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { BacklogPoller } from "../src/daemon/poller.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult, QuotaProbeResult } from "../src/agents/types.js";
import type { BacklogStatus, BacklogIssue, BacklogProject } from "../src/backlog/types.js";

class MockQuotaRunner implements IAgentRunner {
  private resultHandler: (role: AgentRole) => AgentResult;
  private recovered: boolean = true;
  public probeCount: number = 0;

  constructor(resultHandler: (role: AgentRole) => AgentResult) {
    this.resultHandler = resultHandler;
  }

  setResultHandler(handler: (role: AgentRole) => AgentResult) {
    this.resultHandler = handler;
  }

  setQuotaRecovered(recovered: boolean) {
    this.recovered = recovered;
  }

  async run(role: AgentRole): Promise<AgentResult> {
    return this.resultHandler(role);
  }

  async probeQuotaRecovery(): Promise<QuotaProbeResult> {
    this.probeCount++;
    return {
      recovered: this.recovered,
      errorMessage: this.recovered ? undefined : "Individual quota reached. Resets in 30m.",
      resetDurationSec: this.recovered ? undefined : 1800,
      resetDurationText: this.recovered ? undefined : "30m",
    };
  }
}

describe("クォータ制限ロック & バックログポーリング休止 & 自動回復・再開", () => {
  const testLockPath = "test-quota.lock";
  const testLogPath = "logs/test-quota.jsonl";

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

  let lastPostedComment = "";
  let lastUpdatedStatusId: number | null = null;
  let lastUpdatedSummary: string | null = null;
  let getIssuesCallCount = 0;
  let mockIssue: BacklogIssue;
  let logger: JsonlLogger;

  const mockBacklog = {
    getProject: async (): Promise<BacklogProject> => ({
      id: 100,
      projectKey: "STUDY",
      name: "テストプロジェクト",
    }),
    getProjectStatuses: async () => dummyStatuses,
    getIssue: async (key: string) => {
      return { ...mockIssue, issueKey: key };
    },
    getIssues: async () => {
      getIssuesCallCount++;
      return [mockIssue];
    },
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedStatusId = statusId;
      if (comment) lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssue: async (_key: string, params: { statusId?: number; summary?: string; comment?: string }) => {
      if (params.statusId) lastUpdatedStatusId = params.statusId;
      if (params.summary) lastUpdatedSummary = params.summary;
      if (params.comment) lastPostedComment = params.comment;
      return { id: 1 };
    },
    getComments: async () => [],
  };

  const mockWorktreeManager = {
    ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
      return repoPaths.map((p) => ({
        repoName: "mock-repo",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/mock-repo`,
        branch: issueKey,
      }));
    },
    removeWorktree: async () => {},
    commitAndPushChanges: async () => true,
    getCurrentCommitHash: async () => "abcdef1",
  } as any;

  const mockGitHubService = {
    ensurePullRequests: async () => [],
  } as any;

  beforeEach(() => {
    if (fs.existsSync(testLockPath)) fs.unlinkSync(testLockPath);
    if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);
    lastPostedComment = "";
    lastUpdatedStatusId = null;
    lastUpdatedSummary = null;
    getIssuesCallCount = 0;
    logger = new JsonlLogger(testLogPath);

    mockIssue = {
      id: 101,
      projectId: 100,
      issueKey: "STUDY-5",
      keyId: 5,
      issueType: { id: 1, name: "タスク" },
      summary: "決済APIリファクタリング",
      description: "リポジトリ: /mock/repo",
      status: dummyStatuses[4], // 技術レビュー中 (code-reviewer)
      createdUser: { id: 1, name: "テスト" },
      created: "2026-09-12T00:00:00Z",
      updated: "2026-09-12T00:00:00Z",
    };
  });

  afterEach(() => {
    if (fs.existsSync(testLockPath)) fs.unlinkSync(testLockPath);
    if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);
  });

  describe("1. parseResetDuration ユーティリティ", () => {
    it("時間、分、秒が含まれるエラー文字列から秒数を正しく抽出すること", () => {
      const parsed = parseResetDuration("error: Individual quota reached. Resets in 2h21m6s.");
      expect(parsed).not.toBeNull();
      expect(parsed?.durationSec).toBe(2 * 3600 + 21 * 60 + 6);
      expect(parsed?.durationText).toBe("2h21m6s");
    });

    it("分と秒のみの場合を正しく抽出すること", () => {
      const parsed = parseResetDuration("Resets in 45m30s.");
      expect(parsed).not.toBeNull();
      expect(parsed?.durationSec).toBe(45 * 60 + 30);
    });

    it("分のみの場合を正しく抽出すること", () => {
      const parsed = parseResetDuration("Resets in 30m.");
      expect(parsed).not.toBeNull();
      expect(parsed?.durationSec).toBe(30 * 60);
    });

    it("秒のみの場合を正しく抽出すること", () => {
      const parsed = parseResetDuration("Resets in 15s");
      expect(parsed).not.toBeNull();
      expect(parsed?.durationSec).toBe(15);
    });

    it("リセット時間表記が含まれない場合は null を返すこと", () => {
      const parsed = parseResetDuration("429 Too Many Requests");
      expect(parsed).toBeNull();
    });
  });

  describe("2. QuotaLockManager の基本機能", () => {
    it("ロックの取得、メタデータ読み取り、残り時間計算、解放が正常に動作すること", () => {
      const manager = new QuotaLockManager(testLockPath);
      expect(manager.isLocked()).toBe(false);
      expect(manager.readMetadata()).toBeNull();

      const futureTime = new Date(Date.now() + 60000).toISOString();
      manager.acquire({
        role: "code-reviewer",
        issueKey: "STUDY-5",
        errorMessage: "Quota reached",
        resetsAt: futureTime,
        resetDurationSec: 60,
        resetDurationText: "1m",
      });

      expect(manager.isLocked()).toBe(true);
      const meta = manager.readMetadata();
      expect(meta).not.toBeNull();
      expect(meta?.issueKey).toBe("STUDY-5");
      expect(meta?.role).toBe("code-reviewer");
      expect(meta?.resetDurationText).toBe("1m");

      const remainingMs = manager.getTimeUntilResetMs();
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(60000);

      // 解放
      expect(manager.release()).toBe(true);
      expect(manager.isLocked()).toBe(false);
    });
  });

  describe("3. Dispatcher でのクォータエラー検知とロックファイル自動作成", () => {
    it("エージェント実行がQuota上限エラーの際、クォータロックファイルが作成されBacklogに案内が投稿されること", async () => {
      const quotaLockManager = new QuotaLockManager(testLockPath);
      const quotaOutput = `[エラー] エージェント [code-reviewer] が異常終了しました (終了コード: 1)。
error: Individual quota reached. Please upgrade your subscription. Resets in 2h21m6s.`;

      const runner = new MockQuotaRunner(() => ({
        role: "code-reviewer",
        success: false,
        isRejection: false,
        summary: "Quota reached",
        output: quotaOutput,
      }));

      const dispatcher = new AgentDispatcher(
        mockBacklog as any,
        runner,
        "/mock/repo",
        false,
        logger,
        mockWorktreeManager,
        mockGitHubService,
        3,
        undefined,
        quotaLockManager
      );

      const res = await dispatcher.processIssue(mockIssue, dummyStatuses);

      expect(res.isEscalation).toBe(true);
      expect(res.isQuota).toBe(true);
      expect(quotaLockManager.isLocked()).toBe(true);

      const meta = quotaLockManager.readMetadata();
      expect(meta?.issueKey).toBe("STUDY-5");
      expect(meta?.role).toBe("code-reviewer");
      expect(meta?.resetDurationText).toBe("2h21m6s");
      expect(meta?.resetsAt).not.toBeNull();

      expect(lastPostedComment).toContain("LLMクォータ上限（Quota reached）を検知しました");
      expect(lastPostedComment).toContain("回復待機モード");
      expect(lastPostedComment).toContain("自動再開");
    });
  });

  describe("4. BacklogPoller でのポーリング休止 & クォータ回復と自動再開", () => {
    it("ロックファイルが存在する場合、Backlog へのポーリング (getIssues) をスキップすること", async () => {
      const quotaLockManager = new QuotaLockManager(testLockPath);
      // 将来のリセット時刻でロックを作成
      quotaLockManager.acquire({
        role: "code-reviewer",
        issueKey: "STUDY-5",
        errorMessage: "Quota reached",
        resetsAt: new Date(Date.now() + 3600000).toISOString(),
        resetDurationSec: 3600,
        resetDurationText: "1h",
      });

      const runner = new MockQuotaRunner(() => ({
        role: "code-reviewer",
        success: true,
        isRejection: false,
        summary: "ok",
        output: "ok",
      }));

      const dispatcher = new AgentDispatcher(
        mockBacklog as any,
        runner,
        "/mock/repo",
        false,
        logger,
        mockWorktreeManager,
        mockGitHubService,
        3,
        undefined,
        quotaLockManager
      );

      const poller = new BacklogPoller(
        mockBacklog as any,
        dispatcher,
        "STUDY",
        undefined,
        10,
        logger,
        undefined,
        2,
        quotaLockManager
      );

      await poller.init();
      getIssuesCallCount = 0;

      // ロック中なので handleQuotaLockedState が呼ばれ、Backlog getIssues は呼ばれない
      await poller.handleQuotaLockedState();

      expect(getIssuesCallCount).toBe(0);
      expect(runner.probeCount).toBe(0); // まだリセット時刻前なのでプローブもしない
      expect(quotaLockManager.isLocked()).toBe(true);
    });

    it("リセット時刻到来後にプローブが成功した場合、ロックが解除され中断チケットが自動再開されること", async () => {
      const quotaLockManager = new QuotaLockManager(testLockPath);
      // 過去のリセット時刻でロックを作成（既に到来済み）
      quotaLockManager.acquire({
        role: "code-reviewer",
        issueKey: "STUDY-5",
        errorMessage: "Quota reached",
        resetsAt: new Date(Date.now() - 1000).toISOString(),
        resetDurationSec: 0,
        resetDurationText: "0s",
      });

      const runner = new MockQuotaRunner(() => ({
        role: "code-reviewer",
        success: true,
        isRejection: false,
        summary: "ok",
        output: "ok",
      }));
      runner.setQuotaRecovered(true);

      const dispatcher = new AgentDispatcher(
        mockBacklog as any,
        runner,
        "/mock/repo",
        false,
        logger,
        mockWorktreeManager,
        mockGitHubService,
        3,
        undefined,
        quotaLockManager
      );

      const poller = new BacklogPoller(
        mockBacklog as any,
        dispatcher,
        "STUDY",
        undefined,
        10,
        logger,
        undefined,
        2,
        quotaLockManager,
        0, // 即時プローブ
        true // autoResume 有効
      );

      await poller.init();

      // クォータロック状態のハンドリング
      await poller.handleQuotaLockedState();

      // プローブが実行され、回復を検知してロックが解除されること
      expect(runner.probeCount).toBe(1);
      expect(quotaLockManager.isLocked()).toBe(false);

      // 中断チケット STUDY-5 が自動再開され、Backlog コメントとステータス更新が行われたこと
      expect(lastPostedComment).toContain("【クォータ回復検知】自律処理を自動再開します");
      expect(lastPostedComment).toContain("code-reviewer");
      expect(lastUpdatedStatusId).toBe(5); // 技術レビュー中 (code-reviewer)
    });

    it("手動でロックファイルが削除された場合、通常ポーリングが再開されること", async () => {
      const quotaLockManager = new QuotaLockManager(testLockPath);
      quotaLockManager.acquire({
        role: "developer",
        issueKey: "STUDY-5",
        errorMessage: "Quota reached",
        resetsAt: null,
      });

      expect(quotaLockManager.isLocked()).toBe(true);

      // 手動削除 (rm)
      fs.unlinkSync(testLockPath);
      expect(quotaLockManager.isLocked()).toBe(false);

      // 次回 poller ループでは isLocked() が false になるため pollOnce が実行可能になる
    });
  });
});
