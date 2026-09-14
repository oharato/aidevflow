import type { AgentRole } from "../agents/types.js";
import type { DecisionKeyword, ParsedDecision } from "./types.js";

const DECISION_REGEX = /<!--\s*DECISION:\s*([A-Za-z0-9_-]+)\s*-->/gi;

/**
 * 既知の標準決定キーワード
 */
const KNOWN_DECISIONS: Record<string, DecisionKeyword> = {
  PLANNED: "PLANNED",
  IMPLEMENTED: "IMPLEMENTED",
  APPROVED: "APPROVED",
  LGTM: "APPROVED", // エイリアス
  REJECTED: "REJECTED",
  REJECT: "REJECTED", // エイリアス
  HUMAN_REQUIRED: "HUMAN_REQUIRED",
  CONFIRM_HUMAN: "HUMAN_REQUIRED", // エイリアス
};

/**
 * 出力テキストから自然言語によるエスカレーション（確認依頼）を判定する（フォールバック用）
 */
export function hasNaturalLanguageEscalation(output: string): boolean {
  if (!output) return false;

  const negativePatterns = [
    /(?:【人間への確認依頼】|CONFIRM_HUMAN)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
    /(?:必要|事項|エスカレーション)[^。\n]*?(?:【人間への確認依頼】|CONFIRM_HUMAN)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
  ];

  let sanitized = output;
  for (const pattern of negativePatterns) {
    sanitized = sanitized.replace(pattern, "");
  }

  return (
    sanitized.includes("【人間への確認依頼】") ||
    sanitized.includes("CONFIRM_HUMAN")
  );
}

/**
 * 出力テキストから自然言語による差し戻し（Rejection）を判定する（フォールバック用）
 */
export function hasNaturalLanguageRejection(output: string): boolean {
  if (!output) return false;

  const negativePatterns = [
    /(?:差し戻し|REJECT|リジェクト)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
    /(?:指摘|問題|修正)[^。\n]*?(?:差し戻し|REJECT|リジェクト)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
  ];

  let sanitized = output;
  for (const pat of negativePatterns) {
    sanitized = sanitized.replace(pat, "");
  }

  return (
    sanitized.includes("差し戻し") ||
    sanitized.includes("REJECT") ||
    sanitized.includes("リジェクト")
  );
}

/**
 * エージェント出力から決定キーワード（<!-- DECISION: KEYWORD -->）を抽出・解析する。
 * キーワードが複数存在する場合は、最新（テキスト末尾に最も近いもの）を採用する。
 * キーワードが見つからない場合は、従来の自然言語判定に安全にフォールバックする。
 */
export function parseDecision(
  output: string,
  currentRole?: AgentRole
): ParsedDecision {
  if (!output) {
    return {
      keyword: "APPROVED",
      isFallback: true,
    };
  }

  // 1. <!-- DECISION: ... --> をすべて抽出
  const matches = [...output.matchAll(DECISION_REGEX)];
  if (matches.length > 0) {
    // 末尾に最も近い最後のキーワードを採用
    const lastMatch = matches[matches.length - 1];
    const raw = lastMatch[1].toUpperCase();
    const mapped = KNOWN_DECISIONS[raw];
    if (mapped) {
      return {
        keyword: mapped,
        rawKeyword: raw,
        isFallback: false,
      };
    }
  }

  // 2. フォールバック判定 (自然言語)
  if (hasNaturalLanguageEscalation(output)) {
    return {
      keyword: "HUMAN_REQUIRED",
      isFallback: true,
    };
  }

  if (hasNaturalLanguageRejection(output)) {
    return {
      keyword: "REJECTED",
      isFallback: true,
    };
  }

  // ロールに応じたデフォルト推定
  if (currentRole === "spec-writer") {
    return {
      keyword: "PLANNED",
      isFallback: true,
    };
  }

  if (currentRole === "developer") {
    return {
      keyword: "IMPLEMENTED",
      isFallback: true,
    };
  }

  return {
    keyword: "APPROVED",
    isFallback: true,
  };
}
