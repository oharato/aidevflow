import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadConfig } from "../src/config.js";

describe("loadConfig (config.yml / config.local.yml / .env / 環境変数 の階層読み込み)", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-config-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

  it("config.yml < config.local.yml < 環境変数 の順に後勝ちで上書きされること", () => {
    write(
      "config.yml",
      [
        "tracker:",
        "  type: backlog",
        "  backlog: { domain: backlog.com }",
        "  filter: { only_assigned_to_me: true }",
        "agent: { runner: claude, timeout: 15m }",
        "daemon: { max_concurrency: 3, max_consecutive_failures: 7 }",
        "cleanup: { interval_minutes: 45 }",
      ].join("\n")
    );
    write(
      "config.local.yml",
      ["tracker:", "  backlog: { space_id: myspace, project_key: PROJ }", "daemon: { max_concurrency: 1 }"].join("\n")
    );
    write(".env", "BACKLOG_API_KEY=secret-key\n");
    process.env.AGENT_TIMEOUT = "5m";

    const cfg = loadConfig({ baseDir: dir });

    expect(cfg.backlogSpaceId).toBe("myspace");
    expect(cfg.backlogProjectKey).toBe("PROJ");
    expect(cfg.backlogDomain).toBe("backlog.com");
    expect(cfg.backlogApiKey).toBe("secret-key");
    expect(cfg.onlyAssignedToMe).toBe(true);
    expect(cfg.agentRunner).toBe("claude");
    expect(cfg.maxConcurrency).toBe(1); // local が yml を上書き
    expect(cfg.agentTimeout).toBe("5m"); // 環境変数が最優先
    expect(cfg.maxConsecutiveFailures).toBe(7);
    expect(cfg.cleanupIntervalMinutes).toBe(45);
    expect(cfg.loadedFiles.map((f) => path.basename(f)).sort()).toEqual([".env", "config.local.yml", "config.yml"]);
  });

  it("Backlog 接続に必要な値 (space_id / project_key / API キー) が無ければ起動時エラーになること", () => {
    write("config.yml", "tracker: { type: backlog }\n");
    expect(() => loadConfig({ baseDir: dir, ignoreEnv: true })).toThrow(/space_id[\s\S]*project_key[\s\S]*BACKLOG_API_KEY/);
  });

  it("tracker.type が mock なら Backlog 設定なしで起動できること", () => {
    write("config.yml", "tracker: { type: mock }\nagent: { runner: mock }\n");
    const cfg = loadConfig({ baseDir: dir, ignoreEnv: true });
    expect(cfg.trackerType).toBe("mock");
    expect(cfg.agentRunner).toBe("mock");
  });

  it("列挙型の typo は既定値に落とさず起動時エラーにすること", () => {
    write("config.yml", "tracker: { type: backlgo }\n");
    expect(() => loadConfig({ baseDir: dir, ignoreEnv: true })).toThrow(/tracker\.type/);

    write("config.yml", "tracker: { type: mock }\nagent: { runner: cluade }\n");
    expect(() => loadConfig({ baseDir: dir, ignoreEnv: true })).toThrow(/agent\.runner/);
  });

  it("paths.home の ~ をホームディレクトリに展開すること", () => {
    write("config.yml", "tracker: { type: mock }\npaths: { home: ~/my-aidevflow }\n");
    const cfg = loadConfig({ baseDir: dir, ignoreEnv: true });
    expect(cfg.aidevflowHome).toBe(path.join(os.homedir(), "my-aidevflow"));
  });

  it("設定ファイルが無ければ既定値で読み込めること (mock 指定は環境変数)", () => {
    process.env.TRACKER_TYPE = "mock";
    const cfg = loadConfig({ baseDir: dir });
    expect(cfg.trackerType).toBe("mock");
    expect(cfg.agentRunner).toBe("claude");
    expect(cfg.maxConcurrency).toBe(2);
    expect(cfg.loadedFiles).toEqual([]);
  });
});
