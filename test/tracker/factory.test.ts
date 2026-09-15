import { describe, it, expect } from "vitest";
import { createTracker } from "../../src/tracker/factory.js";
import { MockIssueTracker } from "../../src/tracker/adapters/mock-tracker.js";
import { BacklogTracker } from "../../src/tracker/adapters/backlog-tracker.js";
import type { AppConfig } from "../../src/config.js";

describe("createTracker", () => {
  const baseConfig: AppConfig = {
    backlogSpaceId: "test-space",
    backlogDomain: "backlog.jp",
    backlogApiKey: "test-api-key",
    backlogProjectKey: "TEST",
    trackerType: "backlog",
    pollIntervalSec: 10,
    dryRun: true,
    agentRunner: "mock",
    agentWorkDir: "/mock",
    aidevflowHome: "/tmp/aidevflow",
    maxRejectionCount: 3,
    logFilePath: "logs/test.jsonl",
    agentTimeout: "20m",
    maxConcurrency: 2,
    quotaLockFilePath: ".test.quota.lock",
    quotaProbeIntervalSec: 300,
    quotaAutoResume: true,
    requireHumanSpecApproval: false,
  };

  it("trackerType が 'mock' の場合、MockIssueTracker インスタンスを生成すること", () => {
    const config: AppConfig = {
      ...baseConfig,
      trackerType: "mock",
    };
    const tracker = createTracker(config);
    expect(tracker).toBeInstanceOf(MockIssueTracker);
    expect(tracker.trackerType).toBe("mock");
  });

  it("trackerType が 'backlog' かつ APIキーがある場合、BacklogTracker インスタンスを生成すること", () => {
    const tracker = createTracker(baseConfig);
    expect(tracker).toBeInstanceOf(BacklogTracker);
    expect(tracker.trackerType).toBe("backlog");
  });

  it("trackerType が 'backlog' で APIキーが空の場合、エラーを投げること", () => {
    const config: AppConfig = {
      ...baseConfig,
      backlogApiKey: "",
    };
    expect(() => createTracker(config)).toThrowError("BACKLOG_API_KEY が設定されていません");
  });

  it("trackerType が 'github' の場合、準備中エラーを投げること", () => {
    const config: AppConfig = {
      ...baseConfig,
      trackerType: "github",
    };
    expect(() => createTracker(config)).toThrowError("GitHub Issues トラッカーアダプターは現在実装準備中です");
  });
});
