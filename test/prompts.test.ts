import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "../src/agents/prompts.js";
import type { AgentContext } from "../src/agents/types.js";

describe("エージェントプロンプト生成 (buildAgentPrompt)", () => {
  const dummyContext: AgentContext = {
    issueKey: "STUDY-10",
    issueSummary: "ユーザー認証機能の追加",
    issueDescription: "リポジトリ: /repos/auth-service\nJWT認証を実装してください。",
    recentComments: ["[田中]: セキュリティ考慮をお願いします。"],
    workDir: "/worktrees/STUDY-10",
  };

  it("Code-Reviewer (技術レビュー) のプロンプトに言語・ライブラリの最新性・バージョン点検観点が含まれていること", () => {
    const prompt = buildAgentPrompt("code-reviewer", dummyContext);

    expect(prompt).toContain("あなたは【code-reviewer（技術的観点レビューエージェント）】です。");
    expect(prompt).toContain("言語やライブラリのバージョン妥当性");
    expect(prompt).toContain("言語ランタイム（Node.js 等）や依存ライブラリ");
    expect(prompt).toContain("最新安定版");
    expect(prompt).toContain("具体的なバージョン番号で明示・固定");
    expect(prompt).toContain("7日以上のクールダウン");
  });

  it("Code-Reviewer / QA / Developer のプロンプトにGitコンフリクト点検観点が含まれていること", () => {
    const reviewerPrompt = buildAgentPrompt("code-reviewer", dummyContext);
    expect(reviewerPrompt).toContain("ベースブランチとのコンフリクト有無");
    expect(reviewerPrompt).toContain("Gitコンフリクトの有無、およびコード内にコンフリクトマーカー");
    expect(reviewerPrompt).toContain("Gitコンフリクト");

    const qaPrompt = buildAgentPrompt("qa", dummyContext);
    expect(qaPrompt).toContain("ベースブランチとの競合やコンフリクトマーカーの残留など、成果物のマージを阻害する不整合がないか確認する");

    const developerPrompt = buildAgentPrompt("developer", dummyContext);
    expect(developerPrompt).toContain("ベースブランチ（main/master等）とのGitコンフリクトが発生していないこと、およびソースコード内にコンフリクトマーカー");
  });

  it("Developer (実装) のプロンプトに最新安定版の依存選定・固定の指示が含まれていること", () => {
    const prompt = buildAgentPrompt("developer", dummyContext);

    expect(prompt).toContain("あなたは【developer（実装エージェント）】です。");
    expect(prompt).toContain("最新の安定バージョン");
    expect(prompt).toContain("具体的なバージョン番号で明示・固定");
  });

  it("Architect / Tech-Lead / QA のプロンプトも正常に生成されること", () => {
    const architectPrompt = buildAgentPrompt("architect", dummyContext);
    expect(architectPrompt).toContain("あなたは【architect（詳細設計エージェント）】です。");

    const techLeadPrompt = buildAgentPrompt("tech-lead", dummyContext);
    expect(techLeadPrompt).toContain("あなたは【tech-lead（詳細設計レビューエージェント）】です。");

    const qaPrompt = buildAgentPrompt("qa", dummyContext);
    expect(qaPrompt).toContain("あなたは【qa（要件的観点レビューエージェント）】です。");
  });

  it("Fastモード時のCode-Reviewerプロンプトに統合レビュー（技術観点＋要件充足度＋コンフリクト点検）の指示が含まれること", () => {
    const fastContext: AgentContext = {
      ...dummyContext,
      isFastMode: true,
    };
    const prompt = buildAgentPrompt("code-reviewer", fastContext);

    expect(prompt).toContain("あなたは【code-reviewer（統合レビューエージェント）】です。");
    expect(prompt).toContain("本タスクは【Fastモード（軽量パイプライン）】です。");
    expect(prompt).toContain("技術的観点と要件充足度のレビューを1回に統合して実施します");
    expect(prompt).toContain("ベースブランチとのコンフリクト有無");
    expect(prompt).toContain("Gitコンフリクトの有無、およびコード内にコンフリクトマーカー");
    expect(prompt).toContain("承認（LGTM・全工程完了）");
  });
});

describe("コメント履歴圧縮 (compressRecentComments)", () => {
  it("AIの長大な処理報告を大幅に圧縮し、人間のコメントを最優先で保持すること", async () => {
    const { compressRecentComments } = await import("../src/agents/prompts.js");

    const longAiReport = `### [AI] aidevflow [developer] 処理報告
**結果**: 成功 ([完了/承認])
**ブランチ**: \`STUDY-10\`
- 🔗 **GitHub プルリクエスト**: https://github.com/org/repo/pull/1
**所要時間**: 120.5s
**次の想定フェーズ**: [技術レビュー中]
- **新件名**: \`[技術レビュー中] ユーザー認証機能の追加\`

#### 実行ログ・成果物要約:
とても長大な成果物の詳細説明文がここに何千文字も続きます...
- ファイルA作成
- ファイルB修正
- テストコード追加
` + "詳細行... \n".repeat(50);

    const humanInstruction = "[佐藤]: JWTの有効期限は短め（15分）に設定してください。リフレッシュトークンも必須です。";

    const compressed = compressRecentComments([longAiReport, humanInstruction]);

    // 人間の指示は欠損なく残る
    expect(compressed).toContain("JWTの有効期限は短め（15分）に設定してください");
    expect(compressed).toContain("リフレッシュトークンも必須です");

    // AIレポートはサマリーに圧縮され、何千文字もの長大ログは排除される
    expect(compressed).toContain("[AI処理サマリー]:");
    expect(compressed).toContain("**結果**: 成功 ([完了/承認])");
    expect(compressed.length).toBeLessThan(longAiReport.length);
  });
});
