import type { AgentRole } from "../agents/types.js";

/**
 * エージェントが出力する標準の決定キーワード
 */
export type DecisionKeyword =
  | "PLANNED"
  | "IMPLEMENTED"
  | "APPROVED"
  | "REJECTED"
  | "HUMAN_REQUIRED";

/**
 * 読み取り専用ステップ（edit: false）でプロンプトに注入する制約指示
 */
export const READONLY_INSTRUCTION = `
=== 【重要: 権限制限 (Read-Only)】 ===
あなたはこのステップにおいて【完全な読み取り専用（レビュアー）】です。
リポジトリ内のいかなるファイルも作成・編集・削除・コミットしてはなりません。
指摘・フィードバックは出力文（テキスト）のみに記述してください。
=======================================
`.trim();

/**
 * 決定キーワードの解析結果
 */
export interface ParsedDecision {
  keyword: DecisionKeyword;
  rawKeyword?: string;
  isFallback: boolean;
}

/**
 * ステップ遷移ルール
 */
export interface WorkflowRule {
  if?: DecisionKeyword;
  goto: string; // 次のステップ名、または "COMPLETE", "ABORT"
  human_gate?: boolean; // 人間承認待ち（未対応）で一時停止するか
  human_escalation?: boolean; // 確認待ち（未対応）で一時停止するか
}

/**
 * ワークフローステップ定義
 */
export interface WorkflowStep {
  name: string;
  role: AgentRole | string;
  title: string;
  /** ステップ識別プレフィックス/タグ (例: "[詳細設計中]") */
  tracker_tag?: string;
  /** プレフィックス用エイリアス (旧 backlog_tag 相当) */
  step_tag?: string;
  /** 後方互換用フィールド (旧 backlog_tag) */
  backlog_tag: string;
  /** トラッカー/BTS 上のステータス名 (例: "詳細設計") */
  status_name?: string;
  /** 後方互換用フィールド (旧 custom_status) */
  custom_status: string;
  edit: boolean; // true: 編集可, false: 読み取り専用（レビュアー等）
  model?: string;
  effort?: "low" | "medium" | "high";
  instruction?: string; // カスタム指示ファイルの相対パス等
  rules: WorkflowRule[];
}

/**
 * ワークフロー定義全体
 */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  initial_step: string;
  max_steps?: number;
  steps: Record<string, WorkflowStep>;
}

/**
 * ステップ実行後のルール評価結果
 */
export interface StepEvaluationResult {
  nextStepName: string | "COMPLETE" | "ABORT";
  decision: DecisionKeyword;
  isRejection: boolean;
  isEscalation: boolean;
  isHumanGate: boolean;
  targetStepTag?: string;
  targetStatusName?: string;
  targetBacklogTag?: string;
  targetCustomStatus?: string;
}
