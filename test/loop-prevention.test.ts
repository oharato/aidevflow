import fs from "fs";
import { AgentDispatcher } from "../src/daemon/dispatcher.js";
import { BacklogPoller } from "../src/daemon/poller.js";
import { JsonlLogger } from "../src/logger/jsonl.js";
import type { IAgentRunner, AgentRole, AgentResult } from "../src/agents/types.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { GitHubService } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus, BacklogProject } from "../src/backlog/types.js";

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

async function runLoopPreventionTests() {
  console.log("=== 差し戻し無限ループ防止 & 人間確認エスカレーション 単体テスト開始 ===");

  const testLogPath = "logs/test-loop-prevention.jsonl";
  if (fs.existsSync(testLogPath)) {
    fs.unlinkSync(testLogPath);
  }
  const logger = new JsonlLogger(testLogPath);

  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "詳細設計中", color: "#3b9dbd", displayOrder: 2 },
    { id: 3, projectId: 100, name: "設計レビュー中", color: "#868cb7", displayOrder: 3 },
    { id: 4, projectId: 100, name: "実装中", color: "#eda62a", displayOrder: 4 },
    { id: 5, projectId: 100, name: "技術レビュー中", color: "#b0be3c", displayOrder: 5 },
    { id: 6, projectId: 100, name: "要件レビュー中", color: "#e07b9a", displayOrder: 6 },
    { id: 7, projectId: 100, name: "確認待ち", color: "#f42858", displayOrder: 7 },
    { id: 8, projectId: 100, name: "完了", color: "#2779ca", displayOrder: 8 },
  ];

  let lastUpdatedStatusId: number | null = null;
  let lastPostedComment = "";

  const mockBacklog = {
    getComments: async () => [],
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedStatusId = statusId;
      if (comment) lastPostedComment = comment;
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
    ensurePullRequests: async () => [],
  } as unknown as GitHubService;

  const runner = new MockCustomRunner(() => ({
    success: true,
    isRejection: true,
    summary: "レビュー指摘による差し戻し",
    output: "テストコードの網羅性が不足しています。修正してください。",
  }));

  const maxRejections = 3;
  const dispatcher = new AgentDispatcher(
    mockBacklog,
    runner,
    "/mock/repo",
    false,
    logger,
    mockWorktreeManager,
    mockGitHubService,
    maxRejections
  );

  const baseIssue: BacklogIssue = {
    id: 1001,
    projectId: 100,
    issueKey: "STUDY-3",
    keyId: 3,
    issueType: { id: 1, name: "タスク" },
    summary: "決済APIリファクタリング",
    description: "リポジトリ: /mock/payment-service\n決済モジュールの設計と実装",
    status: dummyStatuses[4], // 技術レビュー中 (critic)
    createdUser: { id: 1, name: "ユーザー" },
    created: "2026-09-09T00:00:00Z",
    updated: "2026-09-09T00:00:00Z",
  };

  // ----------------------------------------------------
  // テスト 1: 差し戻しカウントの追跡と上限到達での「確認待ち」エスカレーション
  // ----------------------------------------------------
  console.log("テスト 1: 3回差し戻しで「確認待ち」へエスカレーションされることの検証");

  // 1回目差し戻し (critic -> 実装中)
  let res1 = await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (res1.isEscalation) throw new Error("1回目の差し戻しでエスカレーションされてはいけません");
  if (res1.nextStatusTarget !== "実装") throw new Error(`想定外の遷移先: ${res1.nextStatusTarget}`);
  if (dispatcher.getRejectionCount("STUDY-3") !== 1) throw new Error("差し戻しカウントが1ではありません");
  console.log("  ✓ 1回目の差し戻し: 実装中へ遷移 (カウント: 1)");

  // 2回目差し戻し (critic -> 実装中)
  let res2 = await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (res2.isEscalation) throw new Error("2回目の差し戻しでエスカレーションされてはいけません");
  if (dispatcher.getRejectionCount("STUDY-3") !== 2) throw new Error("差し戻しカウントが2ではありません");
  console.log("  ✓ 2回目の差し戻し: 実装中へ遷移 (カウント: 2)");

  // 3回目差し戻し (上限到達 -> 確認待ち)
  let res3 = await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (!res3.isEscalation) throw new Error("3回目の差し戻しでエスカレーションされるべきです");
  if (res3.nextStatusTarget !== "確認待ち") throw new Error(`想定外の遷移先: ${res3.nextStatusTarget}`);
  if (lastUpdatedStatusId !== 7) throw new Error(`ステータスIDが「確認待ち」(7) に更新されていません: ${lastUpdatedStatusId}`);
  if (!lastPostedComment.includes("【人間への確認依頼】自律パイプラインを一時停止しました")) {
    throw new Error("エスカレーションコメントが含まれていません");
  }
  if (!lastPostedComment.includes("差し戻し上限（3回）に達しました")) {
    throw new Error("上限到達の理由がコメントに含まれていません");
  }
  console.log("  ✓ 3回目の差し戻し: 上限到達により「確認待ち」へ正常にエスカレーション！");

  // ----------------------------------------------------
  // テスト 2: エージェント明示要求（CONFIRM_HUMAN / 【人間への確認依頼】）の即時エスカレーション
  // ----------------------------------------------------
  console.log("\nテスト 2: エージェントからの明示的な確認要請で即時エスカレーション");
  dispatcher.resetRejectionCount("STUDY-3"); // リセット

  runner.setHandler(() => ({
    success: true,
    isRejection: false,
    summary: "仕様の曖昧さを検出",
    output: "外部決済ゲートウェイのタイムアウト時のリトライ仕様が未定義です。【人間への確認依頼】どちらの挙動を採用すべきか指示をお願いします。",
  }));

  const designIssue: BacklogIssue = {
    ...baseIssue,
    status: dummyStatuses[1], // 詳細設計中 (director)
  };

  let resExplicit = await dispatcher.processIssue(designIssue, dummyStatuses);
  if (!resExplicit.isEscalation) throw new Error("明示要求時にエスカレーションされるべきです");
  if (resExplicit.nextStatusTarget !== "確認待ち") throw new Error("確認待ちに遷移していません");
  if (!lastPostedComment.includes("エージェントから人間への確認要請がありました")) {
    throw new Error("確認要請の理由がコメントに含まれていません");
  }
  console.log("  ✓ エージェントの確認依頼タグを検知し即座に「確認待ち」へ遷移！");

  // ----------------------------------------------------
  // テスト 3: 承認（LGTM）による差し戻しカウンターのリセット
  // ----------------------------------------------------
  console.log("\nテスト 3: レビュー承認（LGTM）による差し戻しカウンターリセット");
  // 意図的に差し戻しカウントを増やす
  runner.setHandler(() => ({ success: true, isRejection: true, summary: "指摘", output: "指摘" }));
  await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (dispatcher.getRejectionCount("STUDY-3") !== 1) throw new Error("差し戻しカウント加算失敗");

  // 承認（LGTM）
  runner.setHandler(() => ({ success: true, isRejection: false, summary: "LGTM", output: "技術観点LGTM" }));
  let resApprove = await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (resApprove.isEscalation) throw new Error("承認時にエスカレーションされてはいけません");
  if (dispatcher.getRejectionCount("STUDY-3") !== 0) {
    throw new Error(`承認後にカウンターがリセットされていません: ${dispatcher.getRejectionCount("STUDY-3")}`);
  }
  console.log("  ✓ レビュー承認により差し戻しカウンターが正常にリセットされました！");

  // ----------------------------------------------------
  // テスト 4: 人間が「確認待ち」から戻した際の Poller でのカウンターリセットと再開
  // ----------------------------------------------------
  console.log("\nテスト 4: 人間による「確認待ち」からの復帰と Poller での自動リセット・再開");

  // 1) 再度上限まで差し戻して「確認待ち」状態にする
  runner.setHandler(() => ({ success: true, isRejection: true, summary: "差し戻し", output: "指摘" }));
  await dispatcher.processIssue(baseIssue, dummyStatuses);
  await dispatcher.processIssue(baseIssue, dummyStatuses);
  await dispatcher.processIssue(baseIssue, dummyStatuses);
  if (dispatcher.getRejectionCount("STUDY-3") !== 3) throw new Error("差し戻しカウントが3になっていません");

  // 2) Poller を使ってシミュレーション
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

  // チケット一覧（最初は「確認待ち」になっている）
  let currentIssueState: BacklogIssue = {
    ...baseIssue,
    status: dummyStatuses[6], // 確認待ち
  };

  const pollerBacklog = {
    getProject: async () => dummyProject,
    getProjectStatuses: async () => dummyStatuses,
    getIssues: async () => [currentIssueState],
    getComments: async () => [
      { createdUser: { name: "管理者" }, content: "リトライは指数バックオフで最大3回としてください。" },
    ],
    addComment: async (_key: string, comment: string) => {
      lastPostedComment = comment;
      return { id: 1 };
    },
    updateIssueStatus: async (_key: string, statusId: number, comment?: string) => {
      lastUpdatedStatusId = statusId;
      if (comment) lastPostedComment = comment;
      return { id: 1 };
    },
  } as unknown as BacklogClient;

  const poller = new BacklogPoller(pollerBacklog, dispatcher, "STUDY", undefined, 1, logger);
  await poller.init();

  // 1回目のポーリング: チケットは「確認待ち」（非アクション）。ステータスキャッシュに「確認待ち」が保存される。
  await poller.pollOnce();

  // 人間が回答し、ステータスを「実装中」に変更した！
  currentIssueState = {
    ...baseIssue,
    status: dummyStatuses[3], // 実装中 (artist)
  };

  // エージェントは人間の指示に従い実装完了（LGTM）
  runner.setHandler(() => ({
    success: true,
    isRejection: false,
    summary: "指示に従い実装完了",
    output: "人間の指示に従い指数バックオフのリトライを実装しました。次は技術レビューです。",
  }));

  // 2回目のポーリング: 「確認待ち」からの復帰を検知してカウンターリセット & 実行
  await poller.pollOnce();

  if (dispatcher.getRejectionCount("STUDY-3") !== 0) {
    throw new Error(`人間復帰後に差し戻しカウンターがリセットされていません: ${dispatcher.getRejectionCount("STUDY-3")}`);
  }
  console.log("  ✓ 人間による「確認待ち」解除を検知し、カウンターをリセットして正常に再開されました！");

  // ログファイルに human_escalation イベントが記録されているか確認
  const logContent = fs.readFileSync(testLogPath, "utf8");
  if (!logContent.includes("human_escalation")) {
    throw new Error("ログファイルに human_escalation イベントが記録されていません");
  }
  console.log("  ✓ JSONL ログに human_escalation イベントが正しく記録されました！");

  console.log("\n全ループ防止・人間エスカレーション単体テストに成功しました！");
}

runLoopPreventionTests().catch((err) => {
  console.error("テスト失敗:", err);
  process.exit(1);
});
