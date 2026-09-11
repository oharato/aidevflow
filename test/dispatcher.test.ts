import { describe, it, expect } from "vitest";
import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { MockRunner } from "../src/agents/runner.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../src/backlog/types.js";

describe("AgentDispatcher (複数リポジトリ・PR連携含む)", () => {
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

  it("ステータス名から担当ロールを正しく判定できること", () => {
    const dispatcher = new AgentDispatcher(
      {} as BacklogClient,
      new MockRunner(),
      "/mock/repo"
    );
    expect(dispatcher.resolveRoleFromStatus("実装中")).toBe("developer");
    expect(dispatcher.resolveRoleFromStatus("詳細設計中")).toBe("spec-writer");
    expect(dispatcher.resolveRoleFromStatus("設計レビュー中")).toBe("spec-reviewer");
    expect(dispatcher.resolveRoleFromStatus("技術レビュー中")).toBe("code-reviewer");
    expect(dispatcher.resolveRoleFromStatus("要件レビュー中")).toBe("requirement-reviewer");
    expect(dispatcher.resolveRoleFromStatus("不明な状態")).toBeNull();
  });

  it("複数リポジトリを記載したチケットでPR一覧付きレビュー依頼コメントが生成されること", async () => {
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
      updateIssue: async (_key: string, params: { statusId?: number; comment?: string }) => {
        if (params.comment) postedComment = params.comment;
        return { id: 1 };
      },
      updateIssueStatus: async (_key: string, _statusId: number, comment?: string) => {
        if (comment) postedComment = comment;
        return { id: 1 };
      },
    } as unknown as BacklogClient;

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

    const result = await dispatcher.processIssue(multiRepoIssue, dummyStatuses);

    expect(result.handled).toBe(true);
    expect(postedComment).toContain("https://github.com/org/frontend/pull/123");
    expect(postedComment).toContain("https://github.com/org/backend/pull/123");
    expect(postedComment).toContain("GitHub プルリクエスト一覧");

    // 要件受入確認手順・コマンドの検証
    expect(postedComment).toContain("手元での動作確認（ローカル検証）手順");
    expect(postedComment).toContain("git pull origin \"STUDY-3\"");
    expect(postedComment).toContain("git diff origin/main..HEAD --stat");
    expect(postedComment).toContain("確認後の対応アクション");
    expect(postedComment).toContain("GitHub 上でプルリクエストをマージしてください");
    expect(postedComment).toContain("ステータスを **「処理中」** に変更してください");
  });

  it("エージェント結果に usage が含まれる場合、処理報告および全工程完了コメントにトークン消費量と累計消費量が出力されること", async () => {
    let postedComment = "";
    const mockBacklog = {
      getComments: async () => [],
      addComment: async (_key: string, comment: string) => {
        postedComment = comment;
        return { id: 1 };
      },
      updateIssue: async (_key: string, params: { statusId?: number; comment?: string }) => {
        if (params.comment) postedComment = params.comment;
        return { id: 1 };
      },
      updateIssueStatus: async (_key: string, _statusId: number, comment?: string) => {
        if (comment) postedComment = comment;
        return { id: 1 };
      },
    } as unknown as BacklogClient;

    const dummyRunner = {
      run: async () => ({
        success: true,
        isRejection: false,
        summary: "完了",
        output: "全工程完了の報告",
        usage: {
          inputTokens: 5000,
          outputTokens: 1200,
          thinkingTokens: 300,
          totalTokens: 6500,
        },
      }),
      probeQuotaRecovery: async () => ({ recovered: true }),
    };

    const dispatcher = new AgentDispatcher(
      mockBacklog,
      dummyRunner as any,
      "/mock/repo",
      false,
      undefined,
      mockWorktreeManager
    );

    const dummyStatuses: BacklogStatus[] = [
      { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
      { id: 2, projectId: 100, name: "実装中", color: "#eda62a", displayOrder: 2 },
      { id: 3, projectId: 100, name: "要件レビュー中", color: "#e07b9a", displayOrder: 3 },
      { id: 4, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 4 },
    ];

    const issue: BacklogIssue = {
      id: 1002,
      projectId: 100,
      issueKey: "STUDY-4",
      keyId: 4,
      issueType: { id: 1, name: "タスク" },
      summary: "単一リポジトリの機能追加",
      description: "要件説明",
      status: dummyStatuses[2], // 要件レビュー中
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-09T00:00:00Z",
      updated: "2026-09-09T00:00:00Z",
    };

    const result = await dispatcher.processIssue(issue, dummyStatuses);

    expect(result.handled).toBe(true);
    expect(postedComment).toContain("最終フェーズ消費トークン");
    expect(postedComment).toContain("5,000");
    expect(postedComment).toContain("1,200");
    expect(postedComment).toContain("6,500 tokens");
    expect(postedComment).toContain("手元での動作確認（ローカル検証）手順");
    expect(postedComment).toContain("git pull origin \"STUDY-4\"");
  });
});
