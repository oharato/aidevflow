import { describe, it, expect } from "vitest";
import { BacklogPoller } from "../src/daemon/poller.js";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject } from "../src/backlog/types.js";
import type { IAgentRunner, AgentRole, AgentContext, AgentRunResult } from "../src/agents/types.js";

describe("BacklogPoller Concurrency (複数チケット並行開発)", () => {
  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "詳細設計中", color: "#2c9fae", displayOrder: 2 },
    { id: 3, projectId: 100, name: "設計レビュー中", color: "#4488c5", displayOrder: 3 },
    { id: 4, projectId: 100, name: "実装中", color: "#5bb85a", displayOrder: 4 },
    { id: 5, projectId: 100, name: "技術レビュー中", color: "#b0be38", displayOrder: 5 },
    { id: 6, projectId: 100, name: "要件レビュー中", color: "#ea2c00", displayOrder: 6 },
    { id: 7, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 7 },
  ];

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

  const createIssue = (key: string, id: number, statusIndex: number, summary: string): BacklogIssue => ({
    id,
    projectId: 100,
    issueKey: key,
    keyId: id,
    issueType: { id: 1, name: "タスク" },
    summary,
    description: "リポジトリ: /mock/repo",
    status: dummyStatuses[statusIndex],
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-01T00:00:00Z",
    updated: "2026-09-01T00:00:00Z",
  });

  const mockWorktreeManager = {
    getWorktreesDir: () => "/mock/worktrees",
    ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
      return repoPaths.map((p) => ({
        repoName: p.split("/").pop() || "repo",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/${p.split("/").pop()}`,
        branch: issueKey,
      }));
    },
  } as unknown as GitWorktreeManager;

  it("maxConcurrency=2 の場合、複数チケットを同時に並行処理できること", async () => {
    const issues = [
      createIssue("STUDY-10", 1010, 1, "チケット10 (設計)"),
      createIssue("STUDY-11", 1011, 3, "チケット11 (実装)"),
      createIssue("STUDY-12", 1012, 1, "チケット12 (設計)"),
    ];

    let runningCount = 0;
    let maxObservedRunning = 0;
    const executionEvents: string[] = [];

    // 遅延シミュレーションを行うランナー
    class DelayRunner implements IAgentRunner {
      async run(role: AgentRole, context: AgentContext): Promise<AgentRunResult> {
        runningCount++;
        maxObservedRunning = Math.max(maxObservedRunning, runningCount);
        executionEvents.push(`${context.issueKey}-start`);

        // 30ms 処理中
        await new Promise((resolve) => setTimeout(resolve, 30));

        executionEvents.push(`${context.issueKey}-end`);
        runningCount--;

        return {
          success: true,
          isRejection: false,
          summary: `${role} 完了`,
          output: "処理が完了しました。",
        };
      }
    }

    const mockBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => issues,
      getComments: async () => [],
      addComment: async () => ({ id: 1 }),
      updateIssue: async () => ({ id: 1 }),
      updateIssueStatus: async () => ({ id: 1 }),
    } as unknown as BacklogClient;

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      new DelayRunner(),
      "/mock/repo",
      false,
      undefined,
      mockWorktreeManager
    );

    // 並行数 2 で Poller を初期化
    const poller = new BacklogPoller(
      mockBacklog,
      dispatcher,
      "STUDY",
      undefined,
      1,
      undefined,
      undefined,
      2 // maxConcurrency = 2
    );

    await poller.init();
    expect(poller.getMaxConcurrency()).toBe(2);

    // 1回目のポーリング (非同期起動)
    await poller.pollOnce(false);

    // STUDY-10 と STUDY-11 が同時に起動し、STUDY-12 はスロット待ち
    expect(poller.getActiveCount()).toBe(2);
    expect(poller.getInFlightIssues()).toContain("STUDY-10");
    expect(poller.getInFlightIssues()).toContain("STUDY-11");
    expect(poller.getInFlightIssues()).not.toContain("STUDY-12");

    // 全タスクの完了を待機
    await poller.waitForActiveTasks();

    expect(maxObservedRunning).toBe(2);
    expect(poller.getActiveCount()).toBe(0);
    expect(executionEvents).toContain("STUDY-10-start");
    expect(executionEvents).toContain("STUDY-11-start");
    expect(executionEvents).toContain("STUDY-10-end");
    expect(executionEvents).toContain("STUDY-11-end");
  });

  it("実行中のチケット (In-Flight) が次のポーリングで二重起動されないこと", async () => {
    const issues = [
      createIssue("STUDY-20", 1020, 1, "重たいタスク"),
    ];

    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    let continueRunner!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      continueRunner = resolve;
    });

    let startCount = 0;

    class SingleRunner implements IAgentRunner {
      async run(role: AgentRole, context: AgentContext): Promise<AgentRunResult> {
        startCount++;
        resolveStarted();
        await holdPromise;
        return {
          success: true,
          isRejection: false,
          summary: `${role} 完了`,
          output: "完了",
        };
      }
    }

    const mockBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => issues,
      getComments: async () => [],
      addComment: async () => ({ id: 1 }),
      updateIssue: async () => ({ id: 1 }),
      updateIssueStatus: async () => ({ id: 1 }),
    } as unknown as BacklogClient;

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      new SingleRunner(),
      "/mock/repo",
      false,
      undefined,
      mockWorktreeManager
    );

    const poller = new BacklogPoller(
      mockBacklog,
      dispatcher,
      "STUDY",
      undefined,
      1,
      undefined,
      undefined,
      2
    );

    await poller.init();

    // 1回目のポーリング (非同期実行開始)
    await poller.pollOnce(false);
    expect(poller.getActiveCount()).toBe(1);

    // runner が確実に起動したことを待機
    await startedPromise;
    expect(startCount).toBe(1);

    // まだ実行中に 2回目のポーリングを即実行
    await poller.pollOnce(false);
    // STUDY-20 は inFlightIssues に含まれているため二重起動されない
    expect(startCount).toBe(1);
    expect(poller.getActiveCount()).toBe(1);

    // runner の保留を解除して完了させる
    continueRunner();
    await poller.waitForActiveTasks();
    expect(poller.getActiveCount()).toBe(0);
  });
});
