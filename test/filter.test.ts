import { describe, it, expect } from "vitest";
import { BacklogPoller } from "../src/daemon/poller.js";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { MockRunner } from "../src/agents/runner.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject } from "../src/backlog/types.js";

describe("BacklogPoller フィルタリング機能 (ドラフト・通常チケット保護)", () => {
  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 100, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 100, name: "完了", color: "#b0be3c", displayOrder: 4 },
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

  const sampleIssues: BacklogIssue[] = [
    {
      id: 1,
      projectId: 100,
      issueKey: "STUDY-10",
      keyId: 10,
      issueType: { id: 1, name: "タスク" }, // 通常タスク
      category: [{ id: 1, name: "業務改善" }],
      summary: "社内備品の棚卸し",
      description: "リポジトリ: /mock/repo",
      status: dummyStatuses[1], // 処理中
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-01T00:00:00Z",
      updated: "2026-09-01T00:00:00Z",
    },
    {
      id: 2,
      projectId: 100,
      issueKey: "STUDY-11",
      keyId: 11,
      issueType: { id: 2, name: "AI開発" }, // AIタスク
      category: [{ id: 2, name: "決済機能" }],
      summary: "決済APIリファクタリング",
      description: "リポジトリ: /mock/repo",
      status: dummyStatuses[1], // 処理中
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-01T00:00:00Z",
      updated: "2026-09-01T00:00:00Z",
    },
    {
      id: 3,
      projectId: 100,
      issueKey: "STUDY-12",
      keyId: 12,
      issueType: { id: 1, name: "タスク" },
      category: [{ id: 3, name: "AI機能" }],
      summary: "[AI] 画像アップロード機能",
      description: "リポジトリ: /mock/repo",
      status: dummyStatuses[1], // 処理中
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-01T00:00:00Z",
      updated: "2026-09-01T00:00:00Z",
    },
  ];

  it("TARGET_ISSUE_TYPE: 特定の種別（AI開発）のみを処理対象とし、通常のタスクを無視すること", async () => {
    const processedKeys: string[] = [];
    const mockBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => sampleIssues,
      getComments: async () => [],
      addComment: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
      updateIssue: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const dispatcher = new AgentDispatcher(mockBacklog, new MockRunner(), "/mock/repo", false);
    const poller = new BacklogPoller(mockBacklog, dispatcher, "STUDY", undefined, 1, undefined, {
      targetIssueType: "AI開発",
    });

    await poller.init();
    await poller.pollOnce();

    expect(processedKeys).toContain("STUDY-11");
    expect(processedKeys).not.toContain("STUDY-10"); // 通常タスクは無視
    expect(processedKeys).not.toContain("STUDY-12"); // タスク種別は無視
  });

  it("TARGET_CATEGORY: 特定のカテゴリー（AI機能）のみを処理対象とすること", async () => {
    const processedKeys: string[] = [];
    const mockBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => sampleIssues,
      getComments: async () => [],
      addComment: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
      updateIssue: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const dispatcher = new AgentDispatcher(mockBacklog, new MockRunner(), "/mock/repo", false);
    const poller = new BacklogPoller(mockBacklog, dispatcher, "STUDY", undefined, 1, undefined, {
      targetCategory: "AI機能",
    });

    await poller.init();
    await poller.pollOnce();

    expect(processedKeys).toContain("STUDY-12");
    expect(processedKeys).not.toContain("STUDY-10");
    expect(processedKeys).not.toContain("STUDY-11");
  });

  it("REQUIRE_AI_TAG: 件名に [AI] タグが含まれるチケットのみを対象とすること", async () => {
    const processedKeys: string[] = [];
    const mockBacklog = {
      getProject: async () => dummyProject,
      getProjectStatuses: async () => dummyStatuses,
      getIssues: async () => sampleIssues,
      getComments: async () => [],
      addComment: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
      updateIssue: async (k: string) => {
        processedKeys.push(k);
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const dispatcher = new AgentDispatcher(mockBacklog, new MockRunner(), "/mock/repo", false);
    const poller = new BacklogPoller(mockBacklog, dispatcher, "STUDY", undefined, 1, undefined, {
      requireAiTag: true,
    });

    await poller.init();
    await poller.pollOnce();

    expect(processedKeys).toContain("STUDY-12"); // [AI] タグあり
    expect(processedKeys).not.toContain("STUDY-10");
    expect(processedKeys).not.toContain("STUDY-11");
  });
});
