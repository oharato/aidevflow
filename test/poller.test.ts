import { BacklogPoller } from "../src/daemon/poller.js";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { MockRunner } from "../src/agents/runner.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject } from "../src/backlog/types.js";

async function runPollerTests() {
  console.log("=== BacklogPoller (プロジェクト走査) テスト開始 ===");

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

  const dummyIssues: BacklogIssue[] = [
    {
      id: 1001,
      projectId: 100,
      issueKey: "STUDY-1",
      keyId: 1,
      issueType: { id: 1, name: "タスク" },
      summary: "完了したチケット",
      description: "これは対象外",
      status: dummyStatuses[6], // 完了
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-01T00:00:00Z",
      updated: "2026-09-01T00:00:00Z",
    },
    {
      id: 1002,
      projectId: 100,
      issueKey: "STUDY-2",
      keyId: 2,
      issueType: { id: 1, name: "タスク" },
      summary: "設計レビュー待ちチケット",
      description: "リポジトリ: /mock/repo\nレビューお願いします",
      status: dummyStatuses[2], // 設計レビュー中 -> curator
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-02T00:00:00Z",
      updated: "2026-09-02T00:00:00Z",
    },
    {
      id: 1003,
      projectId: 100,
      issueKey: "STUDY-3",
      keyId: 3,
      issueType: { id: 1, name: "タスク" },
      summary: "詳細設計待ちチケット",
      description: "リポジトリ: /mock/repo\n設計お願いします",
      status: dummyStatuses[1], // 詳細設計中 -> director
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-03T00:00:00Z",
      updated: "2026-09-03T00:00:00Z",
    },
  ];

  const processedKeys: string[] = [];

  const mockBacklog = {
    getProject: async (key: string) => {
      if (key !== "STUDY") throw new Error("無効なプロジェクトキー");
      return dummyProject;
    },
    getProjectStatuses: async () => dummyStatuses,
    getIssues: async () => dummyIssues,
    getComments: async () => [],
    addComment: async (issueKey: string) => {
      processedKeys.push(issueKey);
      return { id: 1 };
    },
    updateIssueStatus: async (issueKey: string) => {
      processedKeys.push(issueKey);
      return { id: 1 };
    },
  } as unknown as BacklogClient;

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

  const runner = new MockRunner();
  const dispatcher = new AgentDispatcher(
    mockBacklog,
    runner,
    "/mock/repo",
    false,
    undefined,
    mockWorktreeManager
  );

  const poller = new BacklogPoller(mockBacklog, dispatcher, "STUDY", undefined, 1);

  await poller.init();
  await poller.pollOnce();

  console.log("処理されたチケットキー:", processedKeys);
  if (!processedKeys.includes("STUDY-2")) throw new Error("STUDY-2 (設計レビュー中) が処理されていません");
  if (!processedKeys.includes("STUDY-3")) throw new Error("STUDY-3 (詳細設計中) が処理されていません");
  if (processedKeys.includes("STUDY-1")) throw new Error("STUDY-1 (完了) は処理されてはいけません");

  console.log("✓ プロジェクト走査 & 条件一致チケット順次ディスパッチのテストに成功しました！");
}

runPollerTests().catch((err) => {
  console.error("Poller テスト失敗:", err);
  process.exit(1);
});
