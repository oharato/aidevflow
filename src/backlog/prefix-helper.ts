import type { AgentRole } from "../agents/types.js";
import type { BacklogStatus } from "./types.js";

// フェーズとプレフィックス名のマッピング
export const PHASE_TAGS = {
  architect: "詳細設計中",
  techLead: "設計レビュー中",
  developer: "実装中",
  codeReviewer: "技術レビュー中",
  requirementReviewer: "要件レビュー中",
  qa: "要件レビュー中", // 後方互換エイリアス
  confirmHuman: "確認待ち",
  completed: "要件レビュー完了",

  // 調査・検討タスク用フェーズタグ
  investigationArchitect: "調査中",
  investigationTechLead: "調査レビュー中",
  investigationCompleted: "調査完了",
} as const;

export type PhaseTag = (typeof PHASE_TAGS)[keyof typeof PHASE_TAGS];

// 既知のプレフィックスタグの正規表現
const ALL_TAGS_PATTERN = Object.values(PHASE_TAGS).join("|");
const PREFIX_REGEX = new RegExp(`^\\s*\\[(${ALL_TAGS_PATTERN})\\]\\s*`, "i");

/**
 * チケットが「調査・検討・設計タスク（実装を行わないタスク）」であるかを判定する。
 * 以下のいずれかに該当する場合に調査タスクと判定：
 * 1. チケット種別（issueType.name）に "調査", "リサーチ", "スパイク", "spike", "investigation", "research" が含まれる
 * 2. カテゴリー名に上記キーワードが含まれる
 * 3. 件名に [調査], 【調査】, [リサーチ], [spike], [investigation], [調査中], [調査レビュー中], [調査完了] が含まれる
 * 4. 本文に "タスク種別: 調査", "種別: 調査", "モード: 調査", "type: investigation" 等が含まれる
 */
export function isInvestigationIssue(issue: {
  summary?: string;
  description?: string;
  issueType?: { name: string };
  category?: Array<{ name: string }>;
}): boolean {
  const keywords = ["調査", "リサーチ", "スパイク", "spike", "investigation", "research"];

  // 1. 種別判定
  if (issue.issueType?.name) {
    const typeName = issue.issueType.name.toLowerCase();
    if (keywords.some((kw) => typeName.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  // 2. カテゴリー判定
  if (issue.category && issue.category.length > 0) {
    for (const cat of issue.category) {
      const catName = cat.name.toLowerCase();
      if (keywords.some((kw) => catName.includes(kw.toLowerCase()))) {
        return true;
      }
    }
  }

  // 3. 件名判定
  if (issue.summary) {
    const summary = issue.summary;
    const summaryPatterns = [
      /\[(?:調査|リサーチ|スパイク|spike|investigation|research|調査中|調査レビュー中|調査完了)\]/i,
      /【(?:調査|リサーチ|スパイク|spike|investigation|research|調査中|調査レビュー中|調査完了)】/i,
    ];
    if (summaryPatterns.some((p) => p.test(summary))) {
      return true;
    }
  }

  // 4. 本文判定
  if (issue.description) {
    const desc = issue.description;
    const descPatterns = [
      /(?:タスク種別|種別|モード|パイプライン|mode|type)\s*[:：\n]\s*[-*]?\s*(?:調査|リサーチ|スパイク|spike|investigation|research)/i,
    ];
    if (descPatterns.some((p) => p.test(desc))) {
      return true;
    }
  }

  return false;
}

/**
 * チケットが「Fastモード（軽量パイプライン: 実装 -> 統合レビュー）」であるかを判定する。
 * 以下のいずれかに該当する場合に Fast モードと判定：
 * 1. 件名に [fast], 【fast】, [軽量], 【軽量】, [quick], 【quick】 が含まれる
 * 2. カテゴリー名に上記キーワードが含まれる
 * 3. 本文に "モード: fast", "パイプライン: fast", "mode: fast", "モード\nfast" 等が含まれる
 */
export function isFastModeIssue(issue: {
  summary?: string;
  description?: string;
  category?: Array<{ name: string }>;
}): boolean {
  const keywords = ["fast", "軽量", "quick"];

  // 1. カテゴリー判定
  if (issue.category && issue.category.length > 0) {
    for (const cat of issue.category) {
      const catName = cat.name.toLowerCase();
      if (keywords.some((kw) => catName.includes(kw.toLowerCase()))) {
        return true;
      }
    }
  }

  // 2. 件名判定
  if (issue.summary) {
    const summary = issue.summary;
    const summaryPatterns = [
      /\[(?:fast|軽量|quick)\]/i,
      /【(?:fast|軽量|quick)】/i,
    ];
    if (summaryPatterns.some((p) => p.test(summary))) {
      return true;
    }
  }

  // 3. 本文判定
  if (issue.description) {
    const desc = issue.description;
    const descPatterns = [
      /(?:タスク種別|種別|モード|パイプライン|mode|type)\s*[:：\n]\s*[-*]?\s*(?:fast|軽量|quick)/i,
    ];
    if (descPatterns.some((p) => p.test(desc))) {
      return true;
    }
  }

  return false;
}

/**
 * プロジェクトのステータス一覧に、カスタム状態が存在するか判定する
 */
export function hasCustomStatuses(statuses: BacklogStatus[]): boolean {
  const customNames = ["詳細設計", "設計レビュー", "技術レビュー", "要件レビュー", "確認待ち"];
  return statuses.some((st) => customNames.some((c) => st.name.includes(c)));
}

/**
 * 件名から既存のフェーズプレフィックスを除去し、純粋なチケットタイトルを返す
 */
export function stripPhasePrefix(summary: string): string {
  return summary.replace(PREFIX_REGEX, "").trim();
}

/**
 * 件名のプレフィックスを解析し、対応するエージェントロールや状態を判定する
 */
export function parsePhaseFromSummary(summary: string): {
  role: AgentRole | null;
  isWaitingConfirmation: boolean;
  isCompleted: boolean;
  tag: string | null;
  cleanSummary: string;
} {
  const match = summary.match(PREFIX_REGEX);
  const cleanSummary = stripPhasePrefix(summary);

  if (!match) {
    return {
      role: null,
      isWaitingConfirmation: false,
      isCompleted: false,
      tag: null,
      cleanSummary,
    };
  }

  const tag = match[1];

  switch (tag) {
    case PHASE_TAGS.investigationArchitect:
    case PHASE_TAGS.architect:
      return { role: "architect", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.investigationTechLead:
    case PHASE_TAGS.techLead:
      return { role: "tech-lead", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.developer:
      return { role: "developer", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.codeReviewer:
      return { role: "code-reviewer", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.requirementReviewer:
    case PHASE_TAGS.qa:
      return { role: "requirement-reviewer", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.confirmHuman:
      return { role: null, isWaitingConfirmation: true, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.investigationCompleted:
    case PHASE_TAGS.completed:
      return { role: null, isWaitingConfirmation: false, isCompleted: true, tag, cleanSummary };
    default:
      return { role: null, isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
  }
}

/**
 * 指定したフェーズタグを件名の先頭に付与した新しい件名を生成する
 */
export function formatSummaryWithPhase(summary: string, phaseTag: string): string {
  const clean = stripPhasePrefix(summary);
  return `[${phaseTag}] ${clean}`;
}

/**
 * 次のフェーズタグ名を取得する
 */
export function getNextPhaseTag(
  currentRole: AgentRole,
  isRejection: boolean,
  isInvestigation: boolean = false,
  isFastMode: boolean = false
): string {
  if (isRejection) {
    switch (currentRole) {
      case "tech-lead":
        return isInvestigation
          ? PHASE_TAGS.investigationArchitect // 調査中
          : PHASE_TAGS.architect; // 詳細設計中
      case "code-reviewer":
      case "requirement-reviewer":
        return PHASE_TAGS.developer; // 実装中
      default:
        return isInvestigation
          ? PHASE_TAGS.investigationArchitect
          : PHASE_TAGS.architect;
    }
  }

  switch (currentRole) {
    case "architect":
      return isInvestigation
        ? PHASE_TAGS.investigationTechLead // 調査レビュー中
        : PHASE_TAGS.techLead; // 設計レビュー中
    case "tech-lead":
      return isInvestigation
        ? PHASE_TAGS.investigationCompleted // 調査完了
        : PHASE_TAGS.developer; // 実装中
    case "developer":
      return PHASE_TAGS.codeReviewer; // 技術レビュー中
    case "code-reviewer":
      return isFastMode
        ? PHASE_TAGS.completed // Fastモード時は code-reviewer 承認で要件レビュー完了（全工程完了）
        : PHASE_TAGS.requirementReviewer; // 要件レビュー中
    case "requirement-reviewer":
      return PHASE_TAGS.completed; // 要件レビュー完了
  }
}
