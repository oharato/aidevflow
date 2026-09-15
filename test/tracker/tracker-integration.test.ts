import { describe, it, expect, beforeEach } from "vitest";
import { MockIssueTracker } from "../../src/tracker/adapters/mock-tracker.js";
import { AgentDispatcher } from "../../src/daemon/dispatcher.js";
import { BacklogPoller } from "../../src/daemon/poller.js";
import { MockRunner } from "../../src/agents/runner.js";
import type { GitWorktreeManager } from "../../src/git/worktree.js";
import type { GitHubService } from "../../src/git/github.js";
import type { PermissionGuard } from "../../src/workflow/permission.js";
import type { IAgentRunner } from "../../src/agents/types.js";
describe("IIssueTracker 統合テスト (MockIssueTracker + Dispatcher + Poller)", () => {
  let tracker: MockIssueTracker;
  let runner: MockRunner;
  let dispatcher: AgentDispatcher;
  let poller: BacklogPoller;

  beforeEach(() => {
    tracker = new MockIssueTracker();
    runner = new MockRunner(30);
    const mockWorktreeManager = {
      getWorktreesDir: () => "/mock/worktrees",
      ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
        return repoPaths.map((p) => {
          const rawName = p.split("/").pop() || "repo";
          const repoName = rawName.replace(/\.git$/i, "");
          return {
            repoName,
            repoPath: p,
            worktreeDir: `/mock/worktrees/${issueKey}/${repoName}`,
            branch: issueKey,
          };
        });
      },
    } as unknown as GitWorktreeManager;

    const mockGitHubService = {
      ensurePullRequests: async (targets: Array<{ repoName: string }>) => {
        return targets.map((t) => ({
          repoName: t.repoName,
          prUrl: `https://github.com/org/${t.repoName}/pull/123`,
        }));
      },
    } as unknown as GitHubService;

    const mockPermissionGuard = {
      snapshot: async () => ({
        worktreeDir: "/mock",
        headCommit: "abc",
        status: "",
        trackedFiles: {},
      }),
      verifyAndRollback: async () => ({
        rolledBack: false,
        reasons: [],
      }),
    } as unknown as PermissionGuard;

    const createDispatcher = (r: IAgentRunner = runner) => {
      return new AgentDispatcher(
        tracker,
        r,
        "/mock/repo", // defaultRepoPath
        false, // dryRun
        undefined, // logger
        mockWorktreeManager, // worktreeManager
        mockGitHubService, // githubService
        3, // maxRejectionCount
        undefined, // customStatusModeOverride
        undefined, // quotaLockManager
        false, // requireHumanSpecApproval
        mockPermissionGuard // permissionGuard
      );
    };

    dispatcher = createDispatcher();
    poller = new BacklogPoller(
      tracker,
      dispatcher,
      "TEST",
      undefined,
      10,
      undefined,
      undefined,
      2
    );
  });

  it("MockIssueTracker 上の進行中チケットをポーリング検知してディスパッチできること", async () => {
    await poller.init();

    tracker.addMockIssue({
      key: "TEST-101",
      title: "新機能の設計",
      description: "要件: 検索機能の追加\nリポジトリ: /mock/repo",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    // pollOnce を実行
    await poller.pollOnce();
    // 非同期ディスパッチタスクの完了を待機
    await poller.waitForActiveTasks();

    // 正常に処理され、inFlight 状態が解除されていること
    expect(poller.getActiveCount()).toBe(0);
    expect(poller.getInFlightIssues()).not.toContain("TEST-101");

    // ステップが進んでいること
    const updated = await tracker.getIssue("TEST-101");
    expect(updated.currentStepName).toBe("spec-reviewer");
  });

  it("Dispatcher で MockIssueTracker のステップ遷移とコメント投稿が実行されること", async () => {
    tracker.addMockIssue({
      key: "TEST-102",
      title: "タスク仕様策定",
      description: "要件定義書を作成する\nリポジトリ: /mock/repo",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    const issue = await tracker.getIssue("TEST-102");
    const result = await dispatcher.processIssue(issue);

    expect(result.handled).toBe(true);

    // MockIssueTracker の状態が spec-reviewer に進んでいること
    const updated = await tracker.getIssue("TEST-102");
    expect(updated.currentStepName).toBe("spec-reviewer");
    expect(updated.lifecycleState).toBe("in_progress");

    // コメントが投稿されていること
    const comments = tracker.getPostedComments("TEST-102");
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]).toContain("spec-writer");
  });

  it("エスカレーション検知時に waiting_confirmation に遷移すること", async () => {
    // エスカレーションを発生させる Runner
    const escalatingRunner = {
      run: async () => ({
        success: true,
        output: "判断に迷ったためエスカレーションします\n【人間への確認依頼】DBの選定方針について確認が必要です\nCONFIRM_HUMAN",
      }),
    };

    const mockWorktreeManager = {
      getWorktreesDir: () => "/mock/worktrees",
      ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
        return repoPaths.map((p) => {
          const rawName = p.split("/").pop() || "repo";
          const repoName = rawName.replace(/\.git$/i, "");
          return {
            repoName,
            repoPath: p,
            worktreeDir: `/mock/worktrees/${issueKey}/${repoName}`,
            branch: issueKey,
          };
        });
      },
    } as unknown as GitWorktreeManager;

    const mockGitHubService = {
      ensurePullRequests: async (targets: Array<{ repoName: string }>) => {
        return targets.map((t) => ({
          repoName: t.repoName,
          prUrl: `https://github.com/org/${t.repoName}/pull/123`,
        }));
      },
    } as unknown as GitHubService;

    const mockPermissionGuard = {
      snapshot: async () => ({
        worktreeDir: "/mock",
        headCommit: "abc",
        status: "",
        trackedFiles: {},
      }),
      verifyAndRollback: async () => ({
        rolledBack: false,
        reasons: [],
      }),
    } as unknown as PermissionGuard;

    const escalatingDispatcher = new AgentDispatcher(
      tracker,
      escalatingRunner,
      "/mock/repo",
      false,
      undefined,
      mockWorktreeManager,
      mockGitHubService,
      3,
      undefined,
      undefined,
      false,
      mockPermissionGuard
    );

    tracker.addMockIssue({
      key: "TEST-103",
      title: "DB設計",
      description: "DBアーキテクチャの選定\nリポジトリ: /mock/repo",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    const issue = await tracker.getIssue("TEST-103");
    const result = await escalatingDispatcher.processIssue(issue);

    expect(result.handled).toBe(true);
    expect(result.isEscalation).toBe(true);

    const updated = await tracker.getIssue("TEST-103");
    expect(updated.lifecycleState).toBe("waiting_confirmation");
  });
});
