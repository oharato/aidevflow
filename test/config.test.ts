import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig (環境変数の検証)", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("TRACKER_TYPE の typo は既定値に落とさず起動時エラーにすること", () => {
    process.env.TRACKER_TYPE = "backlgo";
    expect(() => loadConfig()).toThrow(/TRACKER_TYPE/);
  });

  it("AGENT_RUNNER の typo は既定値に落とさず起動時エラーにすること", () => {
    process.env.TRACKER_TYPE = "mock";
    process.env.AGENT_RUNNER = "cluade";
    expect(() => loadConfig()).toThrow(/AGENT_RUNNER/);
  });

  it("有効な値は大文字小文字を区別せず受け付け、ONLY_ASSIGNED_TO_ME / CLAUDE_MODEL を読み込むこと", () => {
    process.env.TRACKER_TYPE = "Mock";
    process.env.AGENT_RUNNER = "CLAUDE";
    process.env.ONLY_ASSIGNED_TO_ME = "true";
    process.env.CLAUDE_MODEL = "claude-sonnet-5";
    const cfg = loadConfig();
    expect(cfg.trackerType).toBe("mock");
    expect(cfg.agentRunner).toBe("claude");
    expect(cfg.onlyAssignedToMe).toBe(true);
    expect(cfg.claudeModel).toBe("claude-sonnet-5");
  });
});
