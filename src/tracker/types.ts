import type { WorkflowDefinition, WorkflowStep } from "../workflow/types.js";

/**
 * チケットの共通ライフサイクル状態
 */
export type IssueLifecycleState =
  | "ready"                // 未着手 (Backlog: 未対応 / GitHub: open)
  | "in_progress"          // ワークフローステップ実行中 (Backlog: 処理中)
  | "waiting_approval"     // 人間の承認ゲート待ち (human_gate: true による一時停止)
  | "waiting_confirmation" // 人間の確認待ち (エスカレーション / 質問 / クォータ枯渇)
  | "completed";           // ワークフロー全工程完了 (処理済み・完了 / PR作成済み)

/**
 * BTS 非依存の統一課題データ型
 */
export interface TrackedIssue {
  /** チケット識別子 (例: "STUDY-3", "issue-42") */
  key: string;

  /** BTS 内部の数値ID (存在する場合) */
  id?: string | number;

  /** クリーンなタイトル (タグ等を除去した要約) */
  title: string;

  /** BTS 上の生のタイトル (例: "[詳細設計中] ユーザー認証の追加") */
  rawTitle: string;

  /** チケット本文 (要件定義、対象リポジトリ指定等) */
  description: string;

  /** チケットから検知された現在のワークフローステップ名 (例: "spec-writer", "architect") */
  currentStepName?: string;

  /** 検知されたステップ定義 (workflow.yaml に合致した場合) */
  currentStepDef?: WorkflowStep;

  /** チケットのライフサイクル状態 */
  lifecycleState: IssueLifecycleState;

  /** BTS 側のステータス名 (表示・ログ用) */
  rawStatusName: string;

  /** Web URL */
  url?: string;

  /** 直近のコメント履歴 (整形済みテキスト配列) */
  recentComments: string[];

  /** 種別名 (例: "タスク", "調査") */
  issueType?: string;

  /** カテゴリー / ラベル一覧 */
  categories?: string[];

  /** 調査タスクフラグ */
  isInvestigation: boolean;

  /** Fast モードフラグ */
  isFastMode: boolean;

  /** 更新日時 (キャッシュ比較用) */
  updatedAt: string;
}

/**
 * ポーリング時のチケット絞り込み条件
 */
export interface IssueFilterOptions {
  targetIssueType?: string;
  targetCategory?: string;
  requireAiTag?: boolean;
}

/**
 * 次ステップへの遷移オプション
 */
export interface StepTransitionOptions {
  comment?: string;
  newSummary?: string;
}

/**
 * ライフサイクル状態の更新オプション
 */
export interface LifecycleTransitionOptions {
  reason?: string;
  comment?: string;
  newSummary?: string;
}

/**
 * 課題管理システム (BTS / Issue Tracker) の抽象インターフェース
 */
export interface IIssueTracker {
  /** トラッカー識別子 ("backlog" | "mock" | "github" 等) */
  readonly trackerType: string;

  /** 初期化 (プロジェクト取得、ステータスモード検知等) */
  init(): Promise<void>;

  /**
   * ワークフロー定義に基づき、着手可能なチケットを取得
   */
  fetchActionableIssues(
    workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]>;

  /**
   * 状態追跡・スキャン対象の候補チケット一覧を取得 (非アクション対象も含む)
   */
  fetchCandidateIssues?(
    workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]>;

  /**
   * 特定チケットの最新状態を取得
   */
  getIssue(key: string, workflowDef?: WorkflowDefinition): Promise<TrackedIssue>;

  /**
   * 次のワークフローステップへ遷移 (BTS のステータスやタグを更新)
   */
  updateIssueStep(
    key: string,
    nextStep: WorkflowStep,
    options?: StepTransitionOptions
  ): Promise<void>;

  /**
   * ライフサイクル状態を変更 (確認待ち、承認待ち、完了等への移行)
   */
  updateLifecycle(
    key: string,
    state: IssueLifecycleState,
    options?: LifecycleTransitionOptions
  ): Promise<void>;

  /**
   * コメントのみを投稿
   */
  addComment(key: string, content: string): Promise<void>;

  /**
   * クリーンアップ対象の完了チケット一覧を取得
   */
  fetchCompletedIssues(): Promise<TrackedIssue[]>;

  /**
   * チケットの最近のコメント履歴（テキスト配列）を取得する
   */
  getRecentComments?(key: string, limit?: number): Promise<string[]>;

  /**
   * カスタムステータスモード（BTSの独自状態名を使用するモード）が有効かを判定
   */
  isCustomStatusMode?(): boolean;

  /**
   * BTS のステータス定義一覧を動的に設定（テスト・モック注入用）
   */
  setProjectStatuses?(statuses: Array<{ id?: number | string; name: string } | unknown>): void;
}
