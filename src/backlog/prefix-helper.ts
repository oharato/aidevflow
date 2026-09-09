import type { AgentRole } from "../agents/types.js";
import type { BacklogStatus } from "./types.js";

// フェーズとプレフィックス名のマッピング
export const PHASE_TAGS = {
  director: "詳細設計中",
  curator: "設計レビュー中",
  artist: "実装中",
  critic: "技術レビュー中",
  editor: "要件レビュー中",
  confirmHuman: "確認待ち",
  completed: "要件レビュー完了",
} as const;

export type PhaseTag = (typeof PHASE_TAGS)[keyof typeof PHASE_TAGS];

// 既知のプレフィックスタグの正規表現
const ALL_TAGS_PATTERN = Object.values(PHASE_TAGS).join("|");
const PREFIX_REGEX = new RegExp(`^\\s*\\[(${ALL_TAGS_PATTERN})\\]\\s*`, "i");

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
    case PHASE_TAGS.director:
      return { role: "director", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.curator:
      return { role: "curator", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.artist:
      return { role: "artist", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.critic:
      return { role: "critic", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.editor:
      return { role: "editor", isWaitingConfirmation: false, isCompleted: false, tag, cleanSummary };
    case PHASE_TAGS.confirmHuman:
      return { role: null, isWaitingConfirmation: true, isCompleted: false, tag, cleanSummary };
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
export function getNextPhaseTag(currentRole: AgentRole, isRejection: boolean): string {
  if (isRejection) {
    switch (currentRole) {
      case "curator":
        return PHASE_TAGS.director; // 詳細設計中
      case "critic":
      case "editor":
        return PHASE_TAGS.artist; // 実装中
      default:
        return PHASE_TAGS.director;
    }
  }

  switch (currentRole) {
    case "director":
      return PHASE_TAGS.curator; // 設計レビュー中
    case "curator":
      return PHASE_TAGS.artist; // 実装中
    case "artist":
      return PHASE_TAGS.critic; // 技術レビュー中
    case "critic":
      return PHASE_TAGS.editor; // 要件レビュー中
    case "editor":
      return PHASE_TAGS.completed; // 要件レビュー完了
  }
}
