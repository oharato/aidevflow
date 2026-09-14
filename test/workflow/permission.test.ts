import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import {
  PermissionGuard,
  getDisallowedToolsArgs,
  READONLY_INSTRUCTION,
} from "../../src/workflow/permission.js";
import { buildAgentPrompt } from "../../src/agents/prompts.js";
import type { AgentContext } from "../../src/agents/types.js";

const execAsync = promisify(exec);

describe("PermissionGuard & 権限制御", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-perm-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("getDisallowedToolsArgs", () => {
    it("editAllowed が true のときは空配列を返すこと", () => {
      expect(getDisallowedToolsArgs(true, "claude")).toEqual([]);
      expect(getDisallowedToolsArgs(true, "agy")).toEqual([]);
    });

    it("editAllowed が false で claude のときはツール制限引数を返すこと", () => {
      const args = getDisallowedToolsArgs(false, "claude");
      expect(args).toContain("--disallowed-tools");
      expect(args[1]).toContain("Edit");
      expect(args[1]).toContain("Write");
    });
  });

  describe("プロンプト制約注入", () => {
    it("context.readOnly が true の場合、プロンプトに READONLY_INSTRUCTION が注入されること", () => {
      const context: AgentContext = {
        issueKey: "STUDY-1",
        issueSummary: "テスト",
        issueDescription: "テスト詳細",
        recentComments: [],
        workDir: tempDir,
        readOnly: true,
      };

      const prompt = buildAgentPrompt("code-reviewer", context);
      expect(prompt).toContain(READONLY_INSTRUCTION);
      expect(prompt).toContain("完全な読み取り専用（レビュアー）");
      expect(prompt).toContain("リポジトリ内のいかなるファイルも作成・編集・削除・コミットしてはなりません");
    });

    it("context.readOnly が false または未定義の場合、READONLY_INSTRUCTION は注入されないこと", () => {
      const context: AgentContext = {
        issueKey: "STUDY-1",
        issueSummary: "テスト",
        issueDescription: "テスト詳細",
        recentComments: [],
        workDir: tempDir,
      };

      const prompt = buildAgentPrompt("code-reviewer", context);
      expect(prompt).not.toContain(READONLY_INSTRUCTION);
    });
  });

  describe("Git スナップショット & 自動ロールバック", () => {
    it("Gitリポジトリでないディレクトリでは isGitRepo: false を返し、エラーなくスキップすること", async () => {
      const guard = new PermissionGuard();
      const snapshot = await guard.snapshot(tempDir);

      expect(snapshot.isGitRepo).toBe(false);

      const result = await guard.verifyAndRollback(snapshot);
      expect(result.rolledBack).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("変更がない場合はロールバックを行わず rolledBack: false を返すこと", async () => {
      // Git リポジトリの初期化
      await execAsync("git init", { cwd: tempDir });
      await execAsync("git config user.name 'Test User'", { cwd: tempDir });
      await execAsync("git config user.email 'test@example.com'", { cwd: tempDir });
      fs.writeFileSync(path.join(tempDir, "file.txt"), "hello");
      await execAsync("git add . && git commit -m 'Initial commit'", { cwd: tempDir });

      const guard = new PermissionGuard();
      const snapshot = await guard.snapshot(tempDir);

      expect(snapshot.isGitRepo).toBe(true);
      expect(snapshot.headCommit).toBeDefined();

      const result = await guard.verifyAndRollback(snapshot);
      expect(result.rolledBack).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("未コミットの新規ファイルや編集が追加された場合、自動で破棄（clean & reset）されること", async () => {
      // Git リポジトリの初期化
      await execAsync("git init", { cwd: tempDir });
      await execAsync("git config user.name 'Test User'", { cwd: tempDir });
      await execAsync("git config user.email 'test@example.com'", { cwd: tempDir });
      fs.writeFileSync(path.join(tempDir, "file.txt"), "original content\n");
      await execAsync("git add . && git commit -m 'Initial commit'", { cwd: tempDir });

      const guard = new PermissionGuard();
      const snapshot = await guard.snapshot(tempDir);

      // レビュアーが不正にファイルを改変・新規作成した状態をシミュレート
      fs.writeFileSync(path.join(tempDir, "file.txt"), "tampered content\n");
      fs.writeFileSync(path.join(tempDir, "rogue_file.txt"), "unwanted file\n");

      // 検証 & ロールバック実行
      const result = await guard.verifyAndRollback(snapshot);

      expect(result.rolledBack).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]).toContain("未コミット");

      // ファイルが元通りに戻っていること
      expect(fs.readFileSync(path.join(tempDir, "file.txt"), "utf-8")).toBe("original content\n");
      expect(fs.existsSync(path.join(tempDir, "rogue_file.txt"))).toBe(false);
    });

    it("不正なコミットが作成された場合、HEAD が元のコミットにリセットされること", async () => {
      // Git リポジトリの初期化
      await execAsync("git init", { cwd: tempDir });
      await execAsync("git config user.name 'Test User'", { cwd: tempDir });
      await execAsync("git config user.email 'test@example.com'", { cwd: tempDir });
      fs.writeFileSync(path.join(tempDir, "file.txt"), "initial\n");
      await execAsync("git add . && git commit -m 'Initial commit'", { cwd: tempDir });

      const guard = new PermissionGuard();
      const snapshot = await guard.snapshot(tempDir);
      const originalCommit = snapshot.headCommit;

      // レビュアーが勝手にコミットを作成した状態をシミュレート
      fs.writeFileSync(path.join(tempDir, "reviewer_change.txt"), "reviewer commit\n");
      await execAsync("git add . && git commit -m 'Reviewer tampered commit'", { cwd: tempDir });

      const { stdout: tamperedHead } = await execAsync("git rev-parse HEAD", { cwd: tempDir });
      expect(tamperedHead.trim()).not.toBe(originalCommit);

      // 検証 & ロールバック実行
      const result = await guard.verifyAndRollback(snapshot);

      expect(result.rolledBack).toBe(true);
      expect(result.restoredCommit).toBe(originalCommit);
      expect(result.reasons[0]).toContain("新しいコミット");

      // HEAD が元のコミットに戻り、コミットされたファイルも消えていること
      const { stdout: restoredHead } = await execAsync("git rev-parse HEAD", { cwd: tempDir });
      expect(restoredHead.trim()).toBe(originalCommit);
      expect(fs.existsSync(path.join(tempDir, "reviewer_change.txt"))).toBe(false);
    });
  });
});
