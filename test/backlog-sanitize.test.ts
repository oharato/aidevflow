import { describe, it, expect } from "vitest";
import { sanitizeBacklogText } from "../src/backlog/client.js";

describe("sanitizeBacklogText (Backlog MySQL utf8互換性サニタイズ)", () => {
  it("一般的な絵文字を安全なテキストタグに置換すること", () => {
    const input = "🤖 AIエージェント ⚠️ 警告 ✅ OK 🚀 起動";
    const result = sanitizeBacklogText(input);
    expect(result).toBe("[AI] AIエージェント [注意] 警告 [OK] OK [実行] 起動");
  });

  it("4バイトUTF-8サロゲートペア（未対応絵文字等）を完全に除去すること", () => {
    // 🍣 (U+1F363, \uD83C\uDF63), 🍕 (U+1F355, \uD83C\uDF55)
    const input = "寿司🍣とピザ🍕を食べる";
    const result = sanitizeBacklogText(input);
    expect(result).toBe("寿司とピザを食べる");
  });

  it("通常の日本語・英数字・記号は変化させないこと", () => {
    const input = "【詳細設計】FastAPI & PostgreSQL (pg_bigm + pgvector) の設計書を作成。";
    const result = sanitizeBacklogText(input);
    expect(result).toBe(input);
  });

  it("空文字やnull/undefined相当の入力を安全に処理すること", () => {
    expect(sanitizeBacklogText("")).toBe("");
  });
});
