import { describe, it, expect, vi, beforeEach } from "vitest";
import { BacklogTracker } from "../../src/tracker/adapters/backlog-tracker.js";
import type { BacklogClient } from "../../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../../src/backlog/types.js";
import { BUILTIN_DEFAULT_WORKFLOW } from "../../src/workflow/loader.js";

type MockBacklogClient = {
  getProject: ReturnType<typeof vi.fn>;
  getMyself: ReturnType<typeof vi.fn>;
  getProjectStatuses: ReturnType<typeof vi.fn>;
  getIssues: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
  updateIssueStatus: ReturnType<typeof vi.fn>;
  addComment: ReturnType<typeof vi.fn>;
};

describe("BacklogTracker", () => {
  let mockClient: MockBacklogClient;
  let tracker: BacklogTracker;

  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 10, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 10, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 10, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  const customStatuses: BacklogStatus[] = [
    { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 101, projectId: 10, name: "詳細設計中", color: "#2c9fa0", displayOrder: 2 },
    { id: 102, projectId: 10, name: "設計レビュー中", color: "#926839", displayOrder: 3 },
    { id: 103, projectId: 10, name: "実装中", color: "#4488c5", displayOrder: 4 },
    { id: 104, projectId: 10, name: "技術レビュー中", color: "#8a58a0", displayOrder: 5 },
    { id: 105, projectId: 10, name: "要件レビュー中", color: "#b07040", displayOrder: 6 },
    { id: 106, projectId: 10, name: "確認待ち", color: "#f42858", displayOrder: 7 },
    { id: 4, projectId: 10, name: "完了", color: "#b0be3c", displayOrder: 8 },
  ];

  beforeEach(() => {
    mockClient = {
      getProject: vi.fn().mockResolvedValue({ id: 10, name: "Test Project", projectKey: "STUDY" }),
      getMyself: vi.fn().mockResolvedValue({ id: 501, name: "ohara" }),
      getProjectStatuses: vi.fn().mockResolvedValue(standardStatuses),
      getIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn(),
      updateIssue: vi.fn().mockResolvedValue({ id: 1 }),
      updateIssueStatus: vi.fn().mockResolvedValue({ id: 1 }),
      addComment: vi.fn().mockResolvedValue({ id: 1 }),
    };

    tracker = new BacklogTracker({
      client: mockClient as unknown as BacklogClient,
      projectKey: "STUDY",
    });
  });

  it("init でプロジェクトとステータスを取得し、モードを自動判別すること", async () => {
    await tracker.init();
    expect(tracker.getProjectId()).toBe(10);
    expect(tracker.isCustomStatusMode()).toBe(false);

    // カスタムステータス環境の検証
    mockClient.getProjectStatuses.mockResolvedValue(customStatuses);
    const customTracker = new BacklogTracker({
      client: mockClient as unknown as BacklogClient,
      projectKey: "STUDY",
    });
    await customTracker.init();
    expect(customTracker.isCustomStatusMode()).toBe(true);
  });

  describe("件名プレフィックスモードでの動作", () => {
    beforeEach(async () => {
      await tracker.init();
    });

    it("件名 [詳細設計中] から spec-writer ステップを動的解決できること", async () => {
      const rawIssue: BacklogIssue = {
        id: 1001,
        projectId: 10,
        issueKey: "STUDY-1",
        keyId: 1,
        issueType: { id: 1, name: "タスク" },
        summary: "[詳細設計中] ユーザー認証機能の追加",
        description: "要件メモ",
        status: { id: 2, projectId: 10, name: "処理中", color: "#4488c5", displayOrder: 2 },
        createdUser: { id: 1, name: "User" },
        created: "2026-09-15T00:00:00Z",
        updated: "2026-09-15T00:00:00Z",
      };

      mockClient.getIssues.mockResolvedValue([rawIssue]);
      const actionable = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW);
      expect(actionable.length).toBe(1);
      expect(actionable[0].key).toBe("STUDY-1");
      expect(actionable[0].title).toBe("ユーザー認証機能の追加");
      expect(actionable[0].currentStepName).toBe("spec-writer");
      expect(actionable[0].lifecycleState).toBe("in_progress");
    });

    it("updateIssueStep でプレフィックスとステータス（処理中）を更新すること", async () => {
      mockClient.getIssue.mockResolvedValue({
        summary: "[詳細設計中] ユーザー認証機能の追加",
        status: { id: 2, name: "処理中" },
      });

      const nextStep = BUILTIN_DEFAULT_WORKFLOW.steps["spec-reviewer"];
      await tracker.updateIssueStep("STUDY-1", nextStep, {
        comment: "設計書作成完了",
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(
        "STUDY-1",
        expect.objectContaining({
          summary: "[設計レビュー中] ユーザー認証機能の追加",
          statusId: 2,
          comment: "設計書作成完了",
        })
      );
    });

    it("updateLifecycle で確認待ち（未対応 + [確認待ち]）に更新できること", async () => {
      mockClient.getIssue.mockResolvedValue({
        summary: "[実装中] ユーザー認証機能の追加",
        status: { id: 2, name: "処理中" },
      });

      await tracker.updateLifecycle("STUDY-1", "waiting_confirmation", {
        comment: "質問があります",
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(
        "STUDY-1",
        expect.objectContaining({
          summary: "[確認待ち] ユーザー認証機能の追加",
          statusId: 1, // 未対応
          comment: "質問があります",
        })
      );
    });
  });

  describe("個人用デーモンモード (onlyAssignedToMe)", () => {
    const makeIssue = (key: string, assignee: { id: number; name: string } | null): BacklogIssue => ({
      id: Number(key.split("-")[1]),
      projectId: 10,
      issueKey: key,
      keyId: Number(key.split("-")[1]),
      issueType: { id: 1, name: "タスク" },
      summary: `[詳細設計中] ${key} のタスク`,
      description: "",
      status: { id: 2, projectId: 10, name: "処理中", color: "#4488c5", displayOrder: 2 },
      assignee,
      createdUser: { id: 1, name: "User" },
      created: "2026-09-15T00:00:00Z",
      updated: "2026-09-15T00:00:00Z",
    });

    beforeEach(async () => {
      await tracker.init();
    });

    it("担当者が自分のチケットのみ返し、他人・未割り当てを除外すること", async () => {
      mockClient.getIssues.mockResolvedValue([
        makeIssue("STUDY-1", { id: 501, name: "ohara" }),
        makeIssue("STUDY-2", { id: 999, name: "someone" }),
        makeIssue("STUDY-3", null),
      ]);

      const actionable = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW, {
        onlyAssignedToMe: true,
      });

      expect(actionable.map((i) => i.key)).toEqual(["STUDY-1"]);
      expect(actionable[0].assigneeId).toBe(501);
      expect(actionable[0].assigneeName).toBe("ohara");
    });

    it("API 呼び出しに assigneeId[] を付与し、自分のユーザー情報は 1 回だけ取得すること", async () => {
      mockClient.getIssues.mockResolvedValue([]);

      await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW, { onlyAssignedToMe: true });
      await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW, { onlyAssignedToMe: true });

      expect(mockClient.getMyself).toHaveBeenCalledTimes(1);
      expect(mockClient.getIssues).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: [10], assigneeId: [501] })
      );
    });

    it("フィルタ未指定時は担当者に関係なく全チケットを返し、getMyself を呼ばないこと", async () => {
      mockClient.getIssues.mockResolvedValue([
        makeIssue("STUDY-1", { id: 501, name: "ohara" }),
        makeIssue("STUDY-2", { id: 999, name: "someone" }),
      ]);

      const actionable = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW);

      expect(actionable.length).toBe(2);
      expect(mockClient.getMyself).not.toHaveBeenCalled();
      expect(mockClient.getIssues).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ assigneeId: expect.anything() })
      );
    });
  });

  describe("課題取得の網羅性 (更新日時降順・ページング・完了除外)", () => {
    beforeEach(async () => {
      await tracker.init();
    });

    it("更新が新しい順 (desc) で取得し、クローズ済み「完了」ステータスを API 側で除外すること", async () => {
      mockClient.getIssues.mockResolvedValue([]);
      await tracker.fetchCandidateIssues(BUILTIN_DEFAULT_WORKFLOW);

      const params = mockClient.getIssues.mock.calls[0][0];
      expect(params.sort).toBe("updated");
      expect(params.order).toBe("desc");
      expect(params.count).toBe(100);
      expect(params.statusId).toEqual([1, 2, 3]); // 完了 (4) を除外、処理済み (3) は含む
    });

    it("100 件を超える場合は offset でページングし、全件を重複なく返すこと", async () => {
      const make = (n: number): BacklogIssue => ({
        id: n,
        projectId: 10,
        issueKey: `STUDY-${n}`,
        keyId: n,
        issueType: { id: 1, name: "タスク" },
        summary: `タスク ${n}`,
        description: "",
        status: { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1 },
        createdUser: { id: 1, name: "User" },
        created: "2026-09-15T00:00:00Z",
        updated: "2026-09-15T00:00:00Z",
      });
      const page1 = Array.from({ length: 100 }, (_, i) => make(i + 1));
      const page2 = Array.from({ length: 30 }, (_, i) => make(i + 101));
      mockClient.getIssues.mockImplementation(async (p: { offset?: number }) =>
        (p.offset || 0) === 0 ? page1 : page2
      );

      const candidates = await tracker.fetchCandidateIssues(BUILTIN_DEFAULT_WORKFLOW);
      expect(candidates.length).toBe(130);
      expect(mockClient.getIssues).toHaveBeenCalledTimes(2);
      expect(mockClient.getIssues.mock.calls[1][0].offset).toBe(100);
    });
  });

  describe("ライフサイクル: 処理済み (completed) と 完了 (closed) の区別", () => {
    const base: Omit<BacklogIssue, "status" | "summary"> = {
      id: 1,
      projectId: 10,
      issueKey: "STUDY-1",
      keyId: 1,
      issueType: { id: 1, name: "タスク" },
      description: "",
      createdUser: { id: 1, name: "User" },
      created: "2026-09-15T00:00:00Z",
      updated: "2026-09-15T00:00:00Z",
    };

    beforeEach(async () => {
      await tracker.init();
    });

    it("「処理済み」+ [要件レビュー完了] は completed (人間の PR レビュー待ち) になること", async () => {
      mockClient.getIssue.mockResolvedValue({
        ...base,
        summary: "[要件レビュー完了] タスク",
        status: standardStatuses[2],
      });
      const issue = await tracker.getIssue("STUDY-1", BUILTIN_DEFAULT_WORKFLOW);
      expect(issue.lifecycleState).toBe("completed");
    });

    it("「完了」は closed (人間がクローズ済み) になること", async () => {
      mockClient.getIssue.mockResolvedValue({
        ...base,
        summary: "[要件レビュー完了] タスク",
        status: standardStatuses[3],
      });
      const issue = await tracker.getIssue("STUDY-1", BUILTIN_DEFAULT_WORKFLOW);
      expect(issue.lifecycleState).toBe("closed");
    });

    it("fetchCompletedIssues は「完了」のみ返し、「処理済み」を含めないこと", async () => {
      mockClient.getIssues.mockResolvedValue([
        { ...base, id: 1, issueKey: "STUDY-1", summary: "[要件レビュー完了] a", status: standardStatuses[2] },
        { ...base, id: 2, issueKey: "STUDY-2", summary: "b", status: standardStatuses[3] },
      ]);
      const done = await tracker.fetchCompletedIssues();
      expect(done.map((i) => i.key)).toEqual(["STUDY-2"]);
    });
  });

  describe("カスタム状態モードで「確認待ち」が未登録の場合", () => {
    it("コメントのみで終わらず、件名 [確認待ち] + 未対応 にフォールバックして停止させること", async () => {
      const partialCustom: BacklogStatus[] = [
        { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1 },
        { id: 101, projectId: 10, name: "詳細設計中", color: "#2c9fa0", displayOrder: 2 },
        { id: 103, projectId: 10, name: "実装中", color: "#4488c5", displayOrder: 3 },
        { id: 4, projectId: 10, name: "完了", color: "#b0be3c", displayOrder: 4 },
      ];
      mockClient.getProjectStatuses.mockResolvedValue(partialCustom);
      const t = new BacklogTracker({ client: mockClient as unknown as BacklogClient, projectKey: "STUDY" });
      await t.init();
      expect(t.isCustomStatusMode()).toBe(true);

      mockClient.getIssue.mockResolvedValue({
        summary: "決済APIの追加",
        status: { id: 103, name: "実装中" },
      });
      await t.updateLifecycle("STUDY-2", "waiting_confirmation", { comment: "質問があります" });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(
        "STUDY-2",
        expect.objectContaining({
          summary: "[確認待ち] 決済APIの追加",
          statusId: 1,
          comment: "質問があります",
        })
      );
    });
  });

  describe("カスタム状態モードでの動作", () => {
    beforeEach(async () => {
      mockClient.getProjectStatuses.mockResolvedValue(customStatuses);
      tracker = new BacklogTracker({
        client: mockClient as unknown as BacklogClient,
        projectKey: "STUDY",
      });
      await tracker.init();
    });

    it("ステータス名「詳細設計中」から spec-writer ステップを動的解決できること", async () => {
      const rawIssue: BacklogIssue = {
        id: 1002,
        projectId: 10,
        issueKey: "STUDY-2",
        keyId: 2,
        issueType: { id: 1, name: "タスク" },
        summary: "決済APIの追加",
        description: "要件",
        status: { id: 101, projectId: 10, name: "詳細設計中", color: "#2c9fa0", displayOrder: 2 },
        createdUser: { id: 1, name: "User" },
        created: "2026-09-15T00:00:00Z",
        updated: "2026-09-15T00:00:00Z",
      };

      mockClient.getIssues.mockResolvedValue([rawIssue]);
      const actionable = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW);
      expect(actionable.length).toBe(1);
      expect(actionable[0].key).toBe("STUDY-2");
      expect(actionable[0].currentStepName).toBe("spec-writer");
    });

    it("updateIssueStep でステータスID（設計レビュー中=102）を更新すること", async () => {
      const nextStep = BUILTIN_DEFAULT_WORKFLOW.steps["spec-reviewer"];
      await tracker.updateIssueStep("STUDY-2", nextStep, {
        comment: "レビュー依頼",
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(
        "STUDY-2",
        expect.objectContaining({
          statusId: 102,
          comment: "レビュー依頼",
        })
      );
    });

    it("updateLifecycle で確認待ちステータス（ID=106）に更新できること", async () => {
      mockClient.getIssue.mockResolvedValue({
        summary: "決済APIの追加",
        status: { id: 101, name: "詳細設計中" },
      });

      await tracker.updateLifecycle("STUDY-2", "waiting_confirmation", {
        comment: "仕様の確認依頼",
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(
        "STUDY-2",
        expect.objectContaining({
          statusId: 106,
          comment: "仕様の確認依頼",
        })
      );
    });
  });
});
