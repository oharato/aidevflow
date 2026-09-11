import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";

let capturedArgs: string[] = [];

vi.mock("child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    capturedArgs = args;
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.killed = false;
    mockChild.kill = vi.fn();

    setTimeout(() => {
      mockChild.stdout.emit(
        "data",
        JSON.stringify({
          event: "result",
          result: { response: "LGTM" },
        }) + "\n"
      );
      mockChild.emit("close", 0);
    }, 5);

    return mockChild;
  }),
}));

import { AgyRunner, TokenUsageTracker } from "../src/agents/runner.js";

describe("AgyRunner モデル・エフォート指定", () => {
  it("モデル名に -high, -medium, -low が含まれる場合、--effort フラグを付与しないこと (コンフリクト防止)", async () => {
    // 1. レビュー用モデル: gemini-3.8-flash-medium, effort: low
    const runner = new AgyRunner(
      "/mock/dir",
      "low",
      "20m",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium"
    );

    await runner.run("code-reviewer", {
      issueKey: "STUDY-4",
      issueSummary: "テスト",
      issueDescription: "テスト",
      recentComments: [],
    });

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("gemini-3.8-flash-medium");
    // --effort は付与されてはいけない (コンフリクト防止)
    expect(capturedArgs).not.toContain("--effort");

    // 2. 通常モデル: gemini-3.8-flash-high, effort: low
    await runner.run("developer", {
      issueKey: "STUDY-4",
      issueSummary: "テスト",
      issueDescription: "テスト",
      recentComments: [],
    });

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("gemini-3.8-flash-high");
    expect(capturedArgs).not.toContain("--effort");
  });

  it("モデル名に -high, -medium, -low が含まれない場合、--effort フラグを正しく付与すること", async () => {
    const runner = new AgyRunner(
      "/mock/dir",
      "low",
      "20m",
      "claude-sonnet-4-6"
    );

    await runner.run("developer", {
      issueKey: "STUDY-4",
      issueSummary: "テスト",
      issueDescription: "テスト",
      recentComments: [],
    });

    expect(capturedArgs).toContain("--model");
    expect(capturedArgs).toContain("claude-sonnet-4-6");
    expect(capturedArgs).toContain("--effort");
    expect(capturedArgs).toContain("low");
  });
});

describe("TokenUsageTracker", () => {
  it("トークン使用量をスレッドセーフに累積集計できること", () => {
    TokenUsageTracker.reset();
    expect(TokenUsageTracker.getTotals()).toEqual({
      sessionCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalCacheReadTokens: 0,
      totalTokens: 0,
    });

    TokenUsageTracker.record({
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: 50,
      cacheReadTokens: 500,
      totalTokens: 1250,
    });

    expect(TokenUsageTracker.getTotals()).toEqual({
      sessionCount: 1,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalThinkingTokens: 50,
      totalCacheReadTokens: 500,
      totalTokens: 1250,
    });

    TokenUsageTracker.record({
      inputTokens: 2000,
      outputTokens: 300,
      thinkingTokens: 100,
      cacheReadTokens: 1000,
      totalTokens: 2400,
    });

    const totals = TokenUsageTracker.getTotals();
    expect(totals.sessionCount).toBe(2);
    expect(totals.totalInputTokens).toBe(3000);
    expect(totals.totalOutputTokens).toBe(500);
    expect(totals.totalThinkingTokens).toBe(150);
    expect(totals.totalCacheReadTokens).toBe(1500);
    expect(totals.totalTokens).toBe(3650);

    const summary = TokenUsageTracker.getSummary();
    expect(summary).toContain("セッション数: 2回");
    expect(summary).toContain("合計: 3,650 tokens");

    TokenUsageTracker.reset();
    expect(TokenUsageTracker.getTotals().sessionCount).toBe(0);
    expect(TokenUsageTracker.getTotals().totalTokens).toBe(0);
  });
});
