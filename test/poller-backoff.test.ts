import { describe, it, expect, vi } from "vitest";
import { IssuePoller } from "../src/daemon/poller.js";
import { MockIssueTracker } from "../src/tracker/adapters/mock-tracker.js";
import type { AgentDispatcher, ProcessIssueResult } from "../src/daemon/dispatcher.js";
import { ResourceCleaner } from "../src/daemon/cleaner.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { IGitHubService } from "../src/git/github.js";
import type { TrackedIssue } from "../src/tracker/types.js";

function makeFakeDispatcher(processIssue: (issue: TrackedIssue) => Promise<ProcessIssueResult>) {
  const calls: string[] = [];
  const dispatcher = {
    setTracker: () => {},
    getQuotaLockManager: () => undefined,
    getWorktreeManager: () => ({ getWorktreesDir: () => "/nonexistent", listIssueKeysWithWorktrees: () => [] }),
    getGitHubService: () => ({}),
    isDryRun: () => true,
    isCustomStatusMode: () => false,
    resolveRole: (issue: TrackedIssue) => issue.currentStepName || null,
    resetRejectionCount: () => {},
    getRunner: () => ({}),
    processIssue: async (issue: TrackedIssue) => {
      calls.push(issue.key);
      return processIssue(issue);
    },
  } as unknown as AgentDispatcher;
  return { dispatcher, calls };
}

function makeCleaner(tracker: MockIssueTracker): ResourceCleaner {
  const cleaner = new ResourceCleaner(
    tracker,
    { getWorktreesDir: () => "/nonexistent", listIssueKeysWithWorktrees: () => [] } as unknown as GitWorktreeManager,
    {} as unknown as IGitHubService
  );
  vi.spyOn(cleaner, "cleanOrphanDockerContainers").mockResolvedValue([]);
  return cleaner;
}

describe("IssuePoller 失敗時バックオフ (同一チケットの毎ポーリング再ディスパッチ防止)", () => {
  it("準備エラー (failed) のチケットはバックオフ期間中に再ディスパッチされないこと", async () => {
    const tracker = new MockIssueTracker();
    tracker.addMockIssue({
      key: "TEST-1",
      title: "リポジトリ未記載タスク",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });
    const { dispatcher, calls } = makeFakeDispatcher(async () => ({ handled: false, failed: true }));
    const poller = new IssuePoller(
      tracker, dispatcher, "TEST", undefined, 10, undefined, undefined, 2,
      undefined, 300, true, makeCleaner(tracker)
    );
    await poller.init();

    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls).toEqual(["TEST-1"]);
  });

  it("処理例外が連続上限 (MAX_CONSECUTIVE_FAILURES) に達したら「確認待ち」に倒して停止すること", async () => {
    process.env.MAX_CONSECUTIVE_FAILURES = "2";
    try {
      const tracker = new MockIssueTracker();
      tracker.addMockIssue({
        key: "TEST-2",
        title: "更新に失敗するタスク",
        currentStepName: "developer",
        lifecycleState: "in_progress",
      });
      const { dispatcher, calls } = makeFakeDispatcher(async () => {
        throw new Error("Backlog API Error [500]");
      });
      // ポーリング間隔 0 秒相当にしてバックオフ待ちを即時経過させる
      const poller = new IssuePoller(
        tracker, dispatcher, "TEST", undefined, 0, undefined, undefined, 2,
        undefined, 300, true, makeCleaner(tracker)
      );
      await poller.init();

      await poller.pollOnce(); // 1 回目失敗
      // 失敗後は fingerprint がキャッシュされるので、チケット側の更新（人間の操作相当）が無ければ再試行されない
      await poller.pollOnce();
      expect(calls).toEqual(["TEST-2"]);

      // チケットが更新されたら（updatedAt が進む）再試行 → 2 回目失敗で上限到達
      const issue = await tracker.getIssue("TEST-2");
      tracker.addMockIssue({ ...issue, updatedAt: new Date(Date.now() + 1000).toISOString() });
      await poller.pollOnce();
      expect(calls).toEqual(["TEST-2", "TEST-2"]);

      const after = await tracker.getIssue("TEST-2");
      expect(after.lifecycleState).toBe("waiting_confirmation");
      expect(tracker.getPostedComments("TEST-2").some((c) => c.includes("連続"))).toBe(true);
    } finally {
      delete process.env.MAX_CONSECUTIVE_FAILURES;
    }
  });

  it("デーモン停止による中断 (interrupted) は失敗として数えず、キャッシュも更新しないこと", async () => {
    const tracker = new MockIssueTracker();
    tracker.addMockIssue({
      key: "TEST-3",
      title: "中断されるタスク",
      currentStepName: "developer",
      lifecycleState: "in_progress",
    });
    const { dispatcher, calls } = makeFakeDispatcher(async () => ({ handled: false, interrupted: true }));
    const poller = new IssuePoller(
      tracker, dispatcher, "TEST", undefined, 10, undefined, undefined, 2,
      undefined, 300, true, makeCleaner(tracker)
    );
    await poller.init();

    await poller.pollOnce();
    await poller.pollOnce();

    // 中断は状態を記録しないので、同じチケットが次回そのまま再ディスパッチされる（再起動後の再開と同じ挙動）
    expect(calls).toEqual(["TEST-3", "TEST-3"]);
    expect((await tracker.getIssue("TEST-3")).lifecycleState).toBe("in_progress");
  });

  it("BACKLOG_ISSUE_KEY 単一チケット監視モードでもフィルタ (担当者) が適用されること", async () => {
    const tracker = new MockIssueTracker();
    tracker.setCurrentUser({ id: 7, name: "me" });
    tracker.addMockIssue({
      key: "TEST-4",
      title: "他人のタスク",
      currentStepName: "developer",
      lifecycleState: "in_progress",
      assigneeId: 8,
    });
    const { dispatcher, calls } = makeFakeDispatcher(async () => ({ handled: true }));
    const poller = new IssuePoller(
      tracker, dispatcher, "TEST", "TEST-4", 10, undefined, { onlyAssignedToMe: true }, 2,
      undefined, 300, true, makeCleaner(tracker)
    );
    await poller.init();
    await poller.pollOnce();
    expect(calls).toEqual([]);
  });
});
