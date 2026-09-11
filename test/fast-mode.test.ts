import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { isFastModeIssue, getNextPhaseTag, PHASE_TAGS } from "../src/backlog/prefix-helper.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, UpdateIssueParams } from "../src/backlog/types.js";

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

describe("Fastモード（軽量パイプライン: 実装 -> 統合レビュー）", () => {
  const testLogPath = "logs/test-fast-mode.jsonl";
  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 100, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 100, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  let lastUpdatedParams: UpdateIssueParams = {};
  let lastPostedComment = "";
  let logger: JsonlLogger;

  beforeEach(() => {
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
    logger = new JsonlLogger(testLogPath);
    lastUpdatedParams = {};
    lastPostedComment = "";
  });

  const mockBacklog = {
    getComments: async () => [],
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssue: async (_key: string, params: UpdateIssueParams) => {
      lastUpdatedParams = { ...params };
      if (params.comment) lastPostedComment = params.comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedParams = { statusId, comment };
      if (comment) lastPostedComment = comment;
      return { id: 1 };
    },
  } as unknown as BacklogClient;

  const mockWorktreeManager = {
    getWorktreesDir: () => "/mock/worktrees",
    ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
      return repoPaths.map((p) => ({
        repoName: "auth-service",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/auth-service`,
        branch: issueKey,
      }));
    },
  } as unknown as GitWorktreeManager;

  const mockGitHubService = {
    ensurePullRequests: async () => [
      { repoName: "auth-service", prUrl: "https://github.com/my-org/auth-service/pull/99" },
    ],
  } as unknown as GitHubService;

  describe("isFastModeIssue 判定", () => {
    it("件名に [fast] や 【軽量】 が含まれる場合に Fast モードと判定されること", () => {
      expect(isFastModeIssue({ summary: "[fast] ログイン画面の文言修正" })).toBe(true);
      expect(isFastModeIssue({ summary: "【軽量】ボタンのカラーコード変更" })).toBe(true);
      expect(isFastModeIssue({ summary: "[quick] CSSの微調整" })).toBe(true);
      expect(isFastModeIssue({ summary: "大型新機能開発" })).toBe(false);
    });

    it("本文にモードやパイプラインとして fast が指定されている場合に判定されること", () => {
      expect(isFastModeIssue({ summary: "バグ修正", description: "モード: fast\n軽微なタイポ修正" })).toBe(true);
      expect(isFastModeIssue({ summary: "バグ修正", description: "パイプライン\n- fast\nアイコン変更" })).toBe(true);
      expect(isFastModeIssue({ summary: "通常開発", description: "詳細設計から行ってください" })).toBe(false);
    });

    it("カテゴリーに fast または 軽量 が含まれる場合に判定されること", () => {
      expect(isFastModeIssue({ summary: "軽微修正", category: [{ name: "軽量" }] })).toBe(true);
      expect(isFastModeIssue({ summary: "通常開発", category: [{ name: "AI開発" }] })).toBe(false);
    });
  });

  describe("Fastモードのライフサイクル（developer -> code-reviewer 統合レビュー -> 全工程完了）", () => {
    it("Fastモードチケット着手時、詳細仕様(spec-writer)をスキップして直接developerが初期ロールとなること", () => {
      const runner = new MockCustomRunner(() => ({ success: true, isRejection: false, summary: "", output: "" }));
      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/auth-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const fastIssue: BacklogIssue = {
        id: 3001,
        projectId: 100,
        issueKey: "STUDY-30",
        keyId: 30,
        issueType: { id: 1, name: "タスク" },
        summary: "[fast] エラーメッセージの修正",
        description: "リポジトリ: /mock/auth-service",
        status: standardStatuses[1], // 処理中
        createdUser: { id: 1, name: "ユーザー" },
        created: "2026-09-11T00:00:00Z",
        updated: "2026-09-11T00:00:00Z",
      };

      const role = dispatcher.resolveRole(fastIssue, standardStatuses);
      expect(role).toBe("developer");
    });

    it("FastモードのDeveloper実装完了によりPRが作成され、件名が[技術レビュー中]に更新されること", async () => {
      const runner = new MockCustomRunner(() => ({
        role: "developer",
        success: true,
        isRejection: false,
        summary: "メッセージ修正完了",
        output: "エラー文言の修正を行いました。次は code-reviewer による統合レビューです。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/auth-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const fastIssue: BacklogIssue = {
        id: 3001,
        projectId: 100,
        issueKey: "STUDY-30",
        keyId: 30,
        issueType: { id: 1, name: "タスク" },
        summary: "[fast] エラーメッセージの修正",
        description: "リポジトリ: /mock/auth-service",
        status: standardStatuses[1], // 処理中
        createdUser: { id: 1, name: "ユーザー" },
        created: "2026-09-11T00:00:00Z",
        updated: "2026-09-11T00:00:00Z",
      };

      const res = await dispatcher.processIssue(fastIssue, standardStatuses);

      expect(res.newSummary).toBe("[技術レビュー中] [fast] エラーメッセージの修正");
      expect(lastUpdatedParams.statusId).toBe(2); // 処理中を維持
      expect(lastPostedComment).toContain("https://github.com/my-org/auth-service/pull/99");
    });

    it("FastモードのCode-Reviewer承認により要件レビュー(requirement-reviewer)をスキップして直接全工程完了・処理済みに遷移すること", async () => {
      const runner = new MockCustomRunner(() => ({
        role: "code-reviewer",
        success: true,
        isRejection: false,
        summary: "統合レビュー承認 (LGTM)",
        output: "技術観点・要件充足度の双方において問題ありません。承認（LGTM・全工程完了）します。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/auth-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const reviewIssue: BacklogIssue = {
        id: 3001,
        projectId: 100,
        issueKey: "STUDY-30",
        keyId: 30,
        issueType: { id: 1, name: "タスク" },
        summary: "[技術レビュー中] [fast] エラーメッセージの修正",
        description: "リポジトリ: /mock/auth-service",
        status: standardStatuses[1], // 処理中
        createdUser: { id: 1, name: "ユーザー" },
        created: "2026-09-11T00:00:00Z",
        updated: "2026-09-11T00:00:00Z",
      };

      const res = await dispatcher.processIssue(reviewIssue, standardStatuses);

      // requirement-reviewer をスキップして直接 [要件レビュー完了] & ステータス 処理済み(3)
      expect(res.newSummary).toBe("[要件レビュー完了] [fast] エラーメッセージの修正");
      expect(lastUpdatedParams.statusId).toBe(3); // 処理済み
      expect(lastPostedComment).toContain("【レビュー依頼】AIエージェントによる全工程が完了しました");
      expect(lastPostedComment).toContain("開発工程（実装 → 統合レビュー）が完了しました");
      expect(lastPostedComment).toContain("統合レビュー報告:");
    });
  });
});
