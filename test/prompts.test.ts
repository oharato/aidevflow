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

  it("Critic (技術レビュー) のプロンプトに言語・ライブラリの最新性・バージョン点検観点が含まれていること", () => {
    const prompt = buildAgentPrompt("critic", dummyContext);

    expect(prompt).toContain("あなたは【critic（技術的観点レビューエージェント）】です。");
    expect(prompt).toContain("言語やライブラリのバージョン妥当性");
    expect(prompt).toContain("言語ランタイム（Node.js 等）や依存ライブラリ");
    expect(prompt).toContain("最新安定版");
    expect(prompt).toContain("具体的なバージョン番号で明示・固定");
    expect(prompt).toContain("7日以上のクールダウン");
  });

  it("Artist (実装) のプロンプトに最新安定版の依存選定・固定の指示が含まれていること", () => {
    const prompt = buildAgentPrompt("artist", dummyContext);

    expect(prompt).toContain("あなたは【artist（実装エージェント）】です。");
    expect(prompt).toContain("最新の安定バージョン");
    expect(prompt).toContain("具体的なバージョン番号で明示・固定");
  });

  it("Director / Curator / Editor のプロンプトも正常に生成されること", () => {
    const directorPrompt = buildAgentPrompt("director", dummyContext);
    expect(directorPrompt).toContain("あなたは【director（詳細設計エージェント）】です。");

    const curatorPrompt = buildAgentPrompt("curator", dummyContext);
    expect(curatorPrompt).toContain("あなたは【curator（詳細設計レビューエージェント）】です。");

    const editorPrompt = buildAgentPrompt("editor", dummyContext);
    expect(editorPrompt).toContain("あなたは【editor（要件的観点レビューエージェント）】です。");
  });
});
