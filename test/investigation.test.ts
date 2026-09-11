import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { isInvestigationIssue, parsePhaseFromSummary, getNextPhaseTag, PHASE_TAGS } from "../src/backlog/prefix-helper.js";
import { buildAgentPrompt } from "../src/agents/prompts.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../src/backlog/types.js";

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

describe("調査タスク（実装を伴わない調査・検討・設計パイプライン）", () => {
  const testLogPath = "logs/test-investigation.jsonl";
  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 100, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 100, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  const customStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "詳細設計中", color: "#3b9dbd", displayOrder: 2 },
    { id: 3, projectId: 100, name: "設計レビュー中", color: "#868cb7", displayOrder: 3 },
    { id: 4, projectId: 100, name: "実装中", color: "#eda62a", displayOrder: 4 },
    { id: 5, projectId: 100, name: "技術レビュー中", color: "#b0be3c", displayOrder: 5 },
    { id: 6, projectId: 100, name: "要件レビュー中", color: "#e07b9a", displayOrder: 6 },
    { id: 7, projectId: 100, name: "確認待ち", color: "#f42858", displayOrder: 7 },
    { id: 8, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 8 },
  ];

  let lastUpdatedParams: { statusId?: number; summary?: string } = {};
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
    updateIssue: async (_key: string, params: { statusId?: number; summary?: string; comment?: string }) => {
      lastUpdatedParams = { statusId: params.statusId, summary: params.summary };
      if (params.comment) lastPostedComment = params.comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedParams = { statusId };
      if (comment) lastPostedComment = comment;
      return { id: 1 };
    },
  } as unknown as BacklogClient;

  const mockWorktreeManager = {
    getWorktreesDir: () => "/mock/worktrees",
    ensureWorktrees: async (repoPaths: string[], issueKey: string) => {
      return repoPaths.map((p) => ({
        repoName: "search-service",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/search-service`,
        branch: issueKey,
      }));
    },
  } as unknown as GitWorktreeManager;

  const mockGitHubService = {
    ensurePullRequests: async () => [],
  } as unknown as GitHubService;

  describe("isInvestigationIssue 判定", () => {
    it("件名に [調査] や 【リサーチ】 が含まれる場合に調査タスクと判定されること", () => {
      expect(isInvestigationIssue({ summary: "[調査] PostgreSQLのベクトル検索ライブラリ選定" })).toBe(true);
      expect(isInvestigationIssue({ summary: "【リサーチ】キャッシュ戦略の比較" })).toBe(true);
      expect(isInvestigationIssue({ summary: "[spike] 認証方式の検討" })).toBe(true);
      expect(isInvestigationIssue({ summary: "[investigation] メモリリークの原因調査" })).toBe(true);
      expect(isInvestigationIssue({ summary: "決済APIリファクタリング" })).toBe(false);
    });

    it("チケット種別やカテゴリーに調査キーワードが含まれる場合に調査タスクと判定されること", () => {
      expect(isInvestigationIssue({ summary: "API設計", issueType: { name: "調査" } })).toBe(true);
      expect(isInvestigationIssue({ summary: "API設計", category: [{ name: "リサーチ" }] })).toBe(true);
      expect(isInvestigationIssue({ summary: "API設計", issueType: { name: "タスク" } })).toBe(false);
    });

    it("本文にタスク種別やモードが明記されている場合に調査タスクと判定されること", () => {
      expect(isInvestigationIssue({ summary: "アーキテクチャ検討", description: "タスク種別: 調査\nマイクロサービスの分割方針" })).toBe(true);
      expect(isInvestigationIssue({ summary: "アーキテクチャ検討", description: "mode: spike\n技術検証" })).toBe(true);
    });

    it("本文にタスク種別やモードが改行区切りや箇条書きで明記されている場合にも調査タスクと判定されること (STUDY-5ケース)", () => {
      const study5Desc = `リポジトリ\nhttps://github.com/oharato/company-search-inquiry\n\n種別\n調査\n\n要件\n宣言的マイグレーションツール atlasを使ってみたい。`;
      expect(isInvestigationIssue({ summary: "マイグレーションツール選定", description: study5Desc })).toBe(true);

      const bulletDesc = `【概要】\nモード\n- 調査\n検証を実施する。`;
      expect(isInvestigationIssue({ summary: "技術検証", description: bulletDesc })).toBe(true);
    });
  });

  describe("調査タスクのプロンプト生成", () => {
    it("isInvestigation: true の場合、spec-writer と spec-reviewer に調査専用のプロンプトが生成されること", () => {
      const dirPrompt = buildAgentPrompt("spec-writer", {
        issueKey: "STUDY-20",
        issueSummary: "[調査] ベクトルDB選定",
        issueDescription: "pgvector と Qdrant の比較",
        recentComments: [],
        workDir: "/mock",
        isInvestigation: true,
      });

      expect(dirPrompt).toContain("【本タスクの種別】");
      expect(dirPrompt).toContain("本タスクは【調査・検討・設計タスク】です。");
      expect(dirPrompt).toContain("リポジトリ内のファイル（ドキュメント、設定、検証コード等）を積極的に作成・編集・修正してください。");
      expect(dirPrompt).toContain("docs/investigation_report.md");
      expect(dirPrompt).toContain("次は spec-reviewer による調査・仕様レビューです");

      const curPrompt = buildAgentPrompt("spec-reviewer", {
        issueKey: "STUDY-20",
        issueSummary: "[調査] ベクトルDB選定",
        issueDescription: "pgvector と Qdrant の比較",
        recentComments: [],
        workDir: "/mock",
        isInvestigation: true,
      });

      expect(curPrompt).toContain("本タスクは【調査・検討・設計タスク】です。");
      expect(curPrompt).toContain("リポジトリ内のドキュメントや変更差分（git diff 等）を確認し");
      expect(curPrompt).toContain("次は全工程完了（調査完了）です");
      expect(curPrompt).toContain("※本タスクは調査タスクのため、developerによる本番コード実装へは進みません");
    });

    it("通常のspec-writerタスクでも「リポジトリにドキュメント残して」等の指示に対応するプロンプトが含まれること", () => {
      const normalDirPrompt = buildAgentPrompt("spec-writer", {
        issueKey: "STUDY-30",
        issueSummary: "検索機能の改善",
        issueDescription: "リポジトリにドキュメント残して",
        recentComments: [],
        workDir: "/mock",
        isInvestigation: false,
      });

      expect(normalDirPrompt).toContain("リポジトリにドキュメント残して");
      expect(normalDirPrompt).toContain("docs/detailed_design.md");
    });
  });

  describe("調査タスクのライフサイクル（件名プレフィックスモード / フリープラン）", () => {
    const investigationIssue: BacklogIssue = {
      id: 2001,
      projectId: 100,
      issueKey: "STUDY-20",
      keyId: 20,
      issueType: { id: 1, name: "タスク" },
      summary: "[調査] ベクトルDBの比較選定",
      description: "リポジトリ: /mock/search-service\npgvector と Qdrant のコスト・性能比較",
      status: standardStatuses[1], // 処理中
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-10T00:00:00Z",
      updated: "2026-09-10T00:00:00Z",
    };

    it("1. 初期着手: spec-writer が実行され、[調査レビュー中] かつ処理中(2)に更新されること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: false,
        summary: "調査報告書作成完了",
        output: "docs/investigation_report.md に調査結果をまとめコミットしました。次は spec-reviewer による調査・仕様レビューです。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      expect(dispatcher.resolveRole(investigationIssue, standardStatuses)).toBe("spec-writer");

      const res = await dispatcher.processIssue(investigationIssue, standardStatuses);

      expect(res.nextStatusTarget).toBe(`[${PHASE_TAGS.investigationSpecReviewer}]`);
      expect(res.newSummary).toBe("[調査レビュー中] [調査] ベクトルDBの比較選定");
      expect(lastUpdatedParams.statusId).toBe(2); // 処理中を維持
      expect(lastUpdatedParams.summary).toBe("[調査レビュー中] [調査] ベクトルDBの比較選定");
    });

    it("2. spec-reviewer 差し戻し時: [調査中] に戻り、ステータスは処理中(2)を維持すること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: true,
        summary: "コスト試算の不足により差し戻し",
        output: "AWS ECS上での運用コスト試算が不足しています。spec-writerへ差し戻します。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const reviewIssue: BacklogIssue = {
        ...investigationIssue,
        summary: "[調査レビュー中] [調査] ベクトルDBの比較選定",
      };

      expect(dispatcher.resolveRole(reviewIssue, standardStatuses)).toBe("spec-reviewer");

      const res = await dispatcher.processIssue(reviewIssue, standardStatuses);

      expect(res.nextStatusTarget).toBe(`[${PHASE_TAGS.investigationSpecWriter}]`);
      expect(res.newSummary).toBe("[調査中] [調査] ベクトルDBの比較選定");
      expect(lastUpdatedParams.statusId).toBe(2); // 処理中
    });

    it("3. spec-reviewer 承認（LGTM）時: [調査完了] かつステータスが処理済み(3)に更新され、調査完了報告が投稿されること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: false,
        summary: "調査・設計レビュー承認",
        output: "調査結果および比較結論の妥当性を確認しました（LGTM）。全工程完了です。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const reviewIssue: BacklogIssue = {
        ...investigationIssue,
        summary: "[調査レビュー中] [調査] ベクトルDBの比較選定",
      };

      const res = await dispatcher.processIssue(reviewIssue, standardStatuses);

      // developer (実装) へは進まず、パイプライン完了！
      expect(res.nextStatusTarget).toBe(`[${PHASE_TAGS.investigationCompleted}]`);
      expect(res.newSummary).toBe("[調査完了] [調査] ベクトルDBの比較選定");
      expect(lastUpdatedParams.statusId).toBe(3); // 処理済み
      expect(lastUpdatedParams.summary).toBe("[調査完了] [調査] ベクトルDBの比較選定");

      // コメント検証
      expect(lastPostedComment).toContain("【調査完了報告】AIエージェントによる調査・設計フェーズが完了しました");
      expect(lastPostedComment).toContain("人間レビュー後の対応手順");
      expect(lastPostedComment).toContain("コード実装へ進める場合は、本調査・設計結果をもとに新しい実装チケットを作成してください");
    });

    it("4. 調査完了後に人間が追加調査を指示してステータスを「処理中」に戻した場合、spec-writer が再起動すること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: false,
        summary: "追加調査完了",
        output: "マネージドサービスの可用性について追加調査しました。次は spec-reviewer による調査・仕様レビューです。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const feedbackIssue: BacklogIssue = {
        ...investigationIssue,
        summary: "[調査完了] [調査] ベクトルDBの比較選定",
        status: standardStatuses[1], // 処理中 (人間が戻した)
      };

      // 実装タスクなら developer だが、調査タスクなので spec-writer が起動する！
      expect(dispatcher.resolveRole(feedbackIssue, standardStatuses)).toBe("spec-writer");

      const res = await dispatcher.processIssue(feedbackIssue, standardStatuses);

      expect(res.nextStatusTarget).toBe(`[${PHASE_TAGS.investigationSpecReviewer}]`);
      expect(res.newSummary).toBe("[調査レビュー中] [調査] ベクトルDBの比較選定");
      expect(lastUpdatedParams.statusId).toBe(2); // 処理中
    });

    it("5. リポジトリのドキュメント修正・PR作成がある場合、調査完了コメントに PR リンクとマージ手順が含まれること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: false,
        summary: "調査・設計レビュー承認",
        output: "調査ドキュメント docs/investigation_report.md の作成を確認しました（LGTM）。",
      }));

      const mockGitHubWithPr = {
        ensurePullRequests: async () => [
          {
            repoName: "search-service",
            prUrl: "https://github.com/org/search-service/pull/42",
            isNew: true,
          },
        ],
      } as unknown as GitHubService;

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubWithPr, 3);

      const reviewIssue: BacklogIssue = {
        ...investigationIssue,
        summary: "[調査レビュー中] [調査] ベクトルDBの比較選定",
      };

      const res = await dispatcher.processIssue(reviewIssue, standardStatuses);

      expect(res.nextStatusTarget).toBe(`[${PHASE_TAGS.investigationCompleted}]`);
      expect(lastPostedComment).toContain("🔗 **GitHub プルリクエスト**");
      expect(lastPostedComment).toContain("https://github.com/org/search-service/pull/42");
      expect(lastPostedComment).toContain("リポジトリの変更をマージする場合は、GitHub 上でプルリクエストをマージしてください。");
    });
  });

  describe("調査タスクのライフサイクル（カスタム状態モード）", () => {
    const customInvestigationIssue: BacklogIssue = {
      id: 2002,
      projectId: 100,
      issueKey: "STUDY-21",
      keyId: 21,
      issueType: { id: 2, name: "調査" },
      summary: "決済代行各社の手数料・仕様比較",
      description: "リポジトリ: /mock/search-service\nStripe と Pay.jp の比較調査",
      status: customStatuses[2], // 設計レビュー中 (spec-reviewer)
      createdUser: { id: 1, name: "ユーザー" },
      created: "2026-09-10T00:00:00Z",
      updated: "2026-09-10T00:00:00Z",
    };

    it("spec-reviewer 承認時に「実装中」へは進まず、「完了」ステータス(8)に更新されること", async () => {
      const runner = new MockCustomRunner(() => ({
        success: true,
        isRejection: false,
        summary: "調査承認",
        output: "調査内容の網羅性を確認しました（LGTM）。",
      }));

      const dispatcher = new AgentDispatcher(mockBacklog, runner, "/mock/search-service", false, logger, mockWorktreeManager, mockGitHubService, 3);

      const res = await dispatcher.processIssue(customInvestigationIssue, customStatuses);

      expect(res.nextStatusTarget).toBe("完了");
      expect(lastUpdatedParams.statusId).toBe(8); // 完了
      expect(lastPostedComment).toContain("【調査完了報告】AIエージェントによる調査・設計フェーズが完了しました");
    });
  });
});
