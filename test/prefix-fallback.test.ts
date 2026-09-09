import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { BacklogPoller } from "../src/daemon/poller.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject, UpdateIssueParams } from "../src/backlog/types.js";

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

async function runPrefixFallbackTests() {
  console.log("=== Backlogフリープラン（標準4状態のみ）件名プレフィックスフォールバック 単体テスト開始 ===");

  const testLogPath = "logs/test-prefix-fallback.jsonl";
  if (fs.existsSync(testLogPath)) {
    fs.unlinkSync(testLogPath);
  }
  const logger = new JsonlLogger(testLogPath);

  // 標準4状態のみ（カスタム状態なし）
  const standardStatuses: BacklogStatus[] = [
    { id: 1, projectId: 5406, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 5406, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 5406, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 5406, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  let lastUpdatedParams: UpdateIssueParams = {};
  let lastPostedComment = "";

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
        repoName: "payment-service",
        repoPath: p,
        worktreeDir: `/mock/worktrees/${issueKey}/payment-service`,
        branch: issueKey,
      }));
    },
  } as unknown as GitWorktreeManager;

  const mockGitHubService = {
    ensurePullRequests: async () => [
      { repoName: "payment-service", prUrl: "https://github.com/my-org/payment-service/pull/10" },
    ],
  } as unknown as GitHubService;

  let currentHandler: (role: AgentRole) => AgentResult = () => ({
    success: true,
    isRejection: false,
    summary: "詳細設計完了",
    output: "API仕様策定完了。次は設計レビューです。",
  });

  const runner = new MockCustomRunner((role) => currentHandler(role));

  const dispatcher = new AgentDispatcher(
    mockBacklog,
    runner,
    "/mock/payment-service",
    false,
    logger,
    mockWorktreeManager,
    mockGitHubService,
    3
  );

  // 1. 自動判別の検証
  if (dispatcher.isCustomStatusMode(standardStatuses)) {
    throw new Error("標準4状態なのにカスタム状態モードと判定されました");
  }
  console.log("✓ カスタム状態不可環境（標準4状態のみ）を自動検出し、件名プレフィックスモードにフォールバック");

  // 2. 新規チケット着手テスト (タグなしで「処理中」 -> director 開始 -> [設計レビュー中] に更新)
  console.log("\nテスト 1: タグなしチケット着手 -> director 完了で [設計レビュー中] に更新");
  const newIssue: BacklogIssue = {
    id: 2001,
    projectId: 5406,
    issueKey: "STUDY-5",
    keyId: 5,
    issueType: { id: 1, name: "タスク" },
    summary: "決済APIリファクタリング", // プレフィックスなし
    description: "リポジトリ: /mock/payment-service\n決済モジュールを修正する",
    status: standardStatuses[1], // 処理中
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-09T00:00:00Z",
    updated: "2026-09-09T00:00:00Z",
  };

  const res1 = await dispatcher.processIssue(newIssue, standardStatuses);
  if (res1.newSummary !== "[設計レビュー中] 決済APIリファクタリング") {
    throw new Error(`想定外の新件名: ${res1.newSummary}`);
  }
  if (lastUpdatedParams.summary !== "[設計レビュー中] 決済APIリファクタリング") {
    throw new Error(`Backlog更新の件名が一致しません: ${lastUpdatedParams.summary}`);
  }
  if (lastUpdatedParams.statusId !== 2) {
    throw new Error(`ステータスが「処理中」(2) ではありません: ${lastUpdatedParams.statusId}`);
  }
  console.log("  ✓ 件名が [設計レビュー中] 決済APIリファクタリング に自動更新され、ステータスは処理中を維持");

  // 3. 設計レビュー承認 -> [実装中] に更新
  console.log("\nテスト 2: 設計レビュー (curator) 承認 -> [実装中] に更新");
  const curatorIssue: BacklogIssue = {
    ...newIssue,
    summary: "[設計レビュー中] 決済APIリファクタリング",
    status: standardStatuses[1], // 処理中
  };

  currentHandler = () => ({
    success: true,
    isRejection: false,
    summary: "設計LGTM",
    output: "設計書の内容を承認しました（LGTM）。次は実装です。",
  });

  const res2 = await dispatcher.processIssue(curatorIssue, standardStatuses);
  if (res2.newSummary !== "[実装中] 決済APIリファクタリング") {
    throw new Error(`想定外の新件名: ${res2.newSummary}`);
  }
  console.log("  ✓ 件名が [実装中] 決済APIリファクタリング に正常更新！");

  // 4. 差し戻し上限到達で [確認待ち] & ステータス「未対応」へエスカレーション
  console.log("\nテスト 3: レビュー差し戻し3回で [確認待ち] & ステータス「未対応」へエスカレーション");
  const artistIssue: BacklogIssue = {
    ...newIssue,
    summary: "[技術レビュー中] 決済APIリファクタリング",
    status: standardStatuses[1], // 処理中
  };

  currentHandler = () => ({
    success: true,
    isRejection: true,
    summary: "テスト不足による差し戻し",
    output: "単体テストのコードカバレッジが不足しています。再修正してください。",
  });

  await dispatcher.processIssue(artistIssue, standardStatuses); // 1回目
  await dispatcher.processIssue(artistIssue, standardStatuses); // 2回目
  const resReject3 = await dispatcher.processIssue(artistIssue, standardStatuses); // 3回目 (上限到達)

  if (!resReject3.isEscalation) throw new Error("3回目でエスカレーションされていません");
  if (resReject3.newSummary !== "[確認待ち] 決済APIリファクタリング") {
    throw new Error(`想定外のエスカレーション件名: ${resReject3.newSummary}`);
  }
  if (lastUpdatedParams.statusId !== 1) {
    throw new Error(`エスカレーション時にステータスが「未対応」(1) になっていません: ${lastUpdatedParams.statusId}`);
  }
  console.log("  ✓ 差し戻し上限により [確認待ち] かつステータス「未対応」に自動変更され、人間へ注意喚起！");

  // 5. 人間が指示を出し、ステータスを「処理中」に戻して再開
  console.log("\nテスト 4: 人間がコメント投稿＆ステータスを「処理中」に戻して自律再開");
  const dummyProject: BacklogProject = {
    id: 5406,
    projectKey: "STUDY",
    name: "勉強プロジェクト",
    chartEnabled: false,
    subtaskingEnabled: false,
    projectLeaderCanEditProjectLeader: false,
    useWiki: false,
    useFileSharing: false,
    useWikiTreeView: false,
    archived: false,
  };

  // チケットは現在「未対応」で「[確認待ち] 決済APIリファクタリング」
  let currentIssueState: BacklogIssue = {
    ...newIssue,
    summary: "[確認待ち] 決済APIリファクタリング",
    status: standardStatuses[0], // 未対応
  };

  const pollerBacklog = {
    getProject: async () => dummyProject,
    getProjectStatuses: async () => standardStatuses,
    getIssues: async () => [currentIssueState],
    getComments: async () => [{ createdUser: { name: "ユーザー" }, content: "カバレッジ基準を80%に緩和して進めてください。" }],
    addComment: async (_k: string, c: string) => {
      lastPostedComment = c;
      return { id: 1 };
    },
    updateIssue: async (_k: string, p: UpdateIssueParams) => {
      lastUpdatedParams = { ...p };
      return { id: 1 };
    },
  } as unknown as BacklogClient;

  const poller = new BacklogPoller(pollerBacklog, dispatcher, "STUDY", undefined, 1, logger);
  await poller.init();

  // 1回目ポーリング: [確認待ち] かつ 未対応 なので非アクション。キャッシュに保存される。
  await poller.pollOnce();

  // 人間が回答し、ステータスを「処理中」に変更した！件名を [実装中] に戻す
  currentIssueState = {
    ...newIssue,
    summary: "[実装中] 決済APIリファクタリング",
    status: standardStatuses[1], // 処理中
  };

  // エージェントは指示に従って実装完了し、技術レビューへ
  currentHandler = () => ({
    success: true,
    isRejection: false,
    summary: "実装完了",
    output: "カバレッジ80%で実装完了しました。次は技術レビューです。",
  });

  // 2回目ポーリング: 復帰検知 & カウンターリセット & ディスパッチ
  await poller.pollOnce();

  if (dispatcher.getRejectionCount("STUDY-5") !== 0) {
    throw new Error(`カウンターがリセットされていません: ${dispatcher.getRejectionCount("STUDY-5")}`);
  }
  if (lastUpdatedParams.summary !== "[技術レビュー中] 決済APIリファクタリング") {
    throw new Error(`新フェーズ [技術レビュー中] に更新されていません: ${lastUpdatedParams.summary}`);
  }
  console.log("  ✓ 人間による「確認待ち」解除を検知し、カウンターをリセットして [技術レビュー中] へ正常再開！");

  // 6. 最終フェーズ (Editor 承認) -> [要件レビュー完了] & ステータス「処理済み」
  console.log("\nテスト 5: 最終フェーズ (Editor 承認) -> [要件レビュー完了] & ステータス「処理済み」");
  const editorIssue: BacklogIssue = {
    ...newIssue,
    summary: "[要件レビュー中] 決済APIリファクタリング",
    status: standardStatuses[1], // 処理中
  };

  currentHandler = () => ({
    success: true,
    isRejection: false,
    summary: "全要件充足",
    output: "すべての要件を満たしていることを確認しました。全工程完了です。",
  });

  const resEditor = await dispatcher.processIssue(editorIssue, standardStatuses);
  if (resEditor.newSummary !== "[要件レビュー完了] 決済APIリファクタリング") {
    throw new Error(`最終件名が不正です: ${resEditor.newSummary}`);
  }
  if (lastUpdatedParams.statusId !== 3) {
    throw new Error(`ステータスが「処理済み」(3) に更新されていません: ${lastUpdatedParams.statusId}`);
  }
  if (!lastPostedComment.includes("【レビュー依頼】AIエージェントによる全工程が完了しました")) {
    throw new Error("レビュー依頼コメントが含まれていません");
  }
  console.log("  ✓ Editor 承認により件名が [要件レビュー完了]、ステータスが「処理済み」(3) に更新！PRレビュー依頼コメント投稿成功！");

  console.log("\n全件名プレフィックスフォールバック単体テストに合格しました！");
}

runPrefixFallbackTests().catch((err) => {
  console.error("テスト失敗:", err);
  process.exit(1);
});
