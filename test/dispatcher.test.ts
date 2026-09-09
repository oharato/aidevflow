import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { MockRunner } from "../src/agents/runner.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../src/backlog/types.js";

async function runTests() {
  console.log("=== AgentDispatcher (複数リポジトリ・PR連携含む) 単体テスト開始 ===");

  const testLogPath = "logs/test-events.jsonl";
  if (fs.existsSync(testLogPath)) {
    fs.unlinkSync(testLogPath);
  }
  const logger = new JsonlLogger(testLogPath);

  let postedComment = "";
  const mockBacklog = {
    getComments: async () => [],
    addComment: async (_key: string, comment: string) => {
      postedComment = comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, _statusId: number, comment?: string) => {
      if (comment) postedComment = comment;
      return { id: 1 };
    },
  } as unknown as BacklogClient;

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
    ensurePullRequests: async (targets: { repoName: string; worktreeDir: string }[]) => {
      return targets.map((t) => ({
        repoName: t.repoName,
        prUrl: `https://github.com/org/${t.repoName}/pull/123`,
      }));
    },
  } as unknown as GitHubService;

  const runner = new MockRunner();
  const dispatcher = new AgentDispatcher(
    mockBacklog,
    runner,
    "/mock/repo",
    false,
    logger,
    mockWorktreeManager,
    mockGitHubService
  );

  // 1. ステータス判定テスト
  const role = dispatcher.resolveRoleFromStatus("実装中");
  if (role !== "artist") throw new Error("resolveRoleFromStatus 失敗");
  console.log("✓ resolveRoleFromStatus 正常");

  // 2. 複数リポジトリを記載したチケットの処理テスト
  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "詳細設計中", color: "#3b9dbd", displayOrder: 2 },
    { id: 3, projectId: 100, name: "設計レビュー中", color: "#868cb7", displayOrder: 3 },
    { id: 4, projectId: 100, name: "実装中", color: "#eda62a", displayOrder: 4 },
    { id: 5, projectId: 100, name: "技術レビュー中", color: "#b0be3c", displayOrder: 5 },
    { id: 6, projectId: 100, name: "要件レビュー中", color: "#e07b9a", displayOrder: 6 },
    { id: 7, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 7 },
  ];

  const multiRepoIssue: BacklogIssue = {
    id: 1001,
    projectId: 100,
    issueKey: "STUDY-3",
    keyId: 3,
    issueType: { id: 1, name: "タスク" },
    summary: "フロントエンドとバックエンドの同時修正",
    description: `
リポジトリ:
- https://github.com/org/frontend.git
- https://github.com/org/backend.git

【要件】
APIとUIを結合する。
`,
    status: dummyStatuses[5], // 要件レビュー中 -> 完了 & レビュー依頼
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-09T00:00:00Z",
    updated: "2026-09-09T00:00:00Z",
  };

  await dispatcher.processIssue(multiRepoIssue, dummyStatuses);

  // 複数PRの一覧がコメントに含まれているか確認
  if (!postedComment.includes("https://github.com/org/frontend/pull/123")) {
    throw new Error(`frontend PR URL が含まれていません: ${postedComment}`);
  }
  if (!postedComment.includes("https://github.com/org/backend/pull/123")) {
    throw new Error(`backend PR URL が含まれていません: ${postedComment}`);
  }
  if (!postedComment.includes("GitHub プルリクエスト一覧")) {
    throw new Error("複数PR一覧の見出しが含まれていません");
  }
  console.log("✓ 複数リポジトリの PR 一覧付きレビュー依頼コメント生成成功！");

  console.log("\n全単体テストに成功しました！");
}

runTests().catch((err) => {
  console.error("テスト失敗:", err);
  process.exit(1);
});
