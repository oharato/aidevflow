import { describe, it, expect } from "vitest";
import {
  parseDecision,
  hasNaturalLanguageEscalation,
  hasNaturalLanguageRejection,
} from "../../src/workflow/decision.js";

describe("DecisionParser", () => {
  describe("決定キーワード (<!-- DECISION: ... -->) の解析", () => {
    it("<!-- DECISION: APPROVED --> を正しく抽出できること", () => {
      const output = "コードレビュー完了しました。問題ありません。\n<!-- DECISION: APPROVED -->";
      const result = parseDecision(output);
      expect(result.keyword).toBe("APPROVED");
      expect(result.isFallback).toBe(false);
      expect(result.rawKeyword).toBe("APPROVED");
    });

    it("<!-- DECISION: REJECTED --> を正しく抽出できること", () => {
      const output = "型エラーが発生しています。修正してください。\n<!-- DECISION: REJECTED -->";
      const result = parseDecision(output);
      expect(result.keyword).toBe("REJECTED");
      expect(result.isFallback).toBe(false);
    });

    it("小文字や前後の空白を含むタグを正しくパースできること", () => {
      const output = "調査完了。\n<!--   decision:   planned   -->";
      const result = parseDecision(output);
      expect(result.keyword).toBe("PLANNED");
      expect(result.isFallback).toBe(false);
    });

    it("エイリアス (LGTM -> APPROVED, CONFIRM_HUMAN -> HUMAN_REQUIRED) を正規化できること", () => {
      const lgtm = "LGTMです。\n<!-- DECISION: LGTM -->";
      expect(parseDecision(lgtm).keyword).toBe("APPROVED");

      const human = "確認が必要です。\n<!-- DECISION: CONFIRM_HUMAN -->";
      expect(parseDecision(human).keyword).toBe("HUMAN_REQUIRED");
    });

    it("複数キーワードが含まれる場合、テキスト末尾（最新）のキーワードを採用すること", () => {
      const output = `
思考プロセス:
最初は <!-- DECISION: REJECTED --> と考えたが、よく見るとテストが通っていた。
結論として承認します。
<!-- DECISION: APPROVED -->
      `.trim();
      const result = parseDecision(output);
      expect(result.keyword).toBe("APPROVED");
      expect(result.isFallback).toBe(false);
    });
  });

  describe("フォールバック (従来の自然言語パース)", () => {
    it("キーワードがなく「差し戻し」が含まれる場合、REJECTED と判定すること", () => {
      const output = "developerへ差し戻します。エラーハンドリングを追加してください。";
      const result = parseDecision(output);
      expect(result.keyword).toBe("REJECTED");
      expect(result.isFallback).toBe(true);
    });

    it("否定文「差し戻しはありません」で誤判定せず、APPROVED またはロール規定値になること", () => {
      const output = "特に指摘はなく、差し戻しはありません。LGTMです。";
      const result = parseDecision(output, "code-reviewer");
      expect(result.keyword).toBe("APPROVED");
      expect(result.isFallback).toBe(true);
    });

    it("「【人間への確認依頼】」が含まれる場合、HUMAN_REQUIRED と判定すること", () => {
      const output = "仕様について【人間への確認依頼】があります。どちらの案にしますか？";
      const result = parseDecision(output);
      expect(result.keyword).toBe("HUMAN_REQUIRED");
      expect(result.isFallback).toBe(true);
    });

    it("否定文「【人間への確認依頼】はありません」で誤検知しないこと", () => {
      const output = "全項目自律解決できたため、【人間への確認依頼】はありません。";
      const result = parseDecision(output, "developer");
      expect(result.keyword).toBe("IMPLEMENTED");
      expect(result.isFallback).toBe(true);
    });

    it("空文字の場合はフォールバックとして APPROVED を返すこと", () => {
      const result = parseDecision("");
      expect(result.keyword).toBe("APPROVED");
      expect(result.isFallback).toBe(true);
    });
  });
});
