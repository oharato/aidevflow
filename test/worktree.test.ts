import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { GitWorktreeManager } from "../src/git/worktree.js";

const execAsync = promisify(exec);

describe("GitWorktreeManager (1チケット・複数リポジトリ共存)", () => {
  const tmpBase = path.resolve(process.cwd(), "test-aidevflow-multi-home");
  const tmpRepoA = path.resolve(process.cwd(), "test-frontend-repo");
  const tmpRepoB = path.resolve(process.cwd(), "test-backend-repo");

  beforeAll(async () => {
    // クリーンアップ & 初期化
    [tmpBase, tmpRepoA, tmpRepoB].forEach((dir) => {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    // リポジトリ A (frontend)
    fs.mkdirSync(tmpRepoA, { recursive: true });
    await execAsync("git init -b main", { cwd: tmpRepoA });
    await execAsync('git config user.name "Test"', { cwd: tmpRepoA });
    await execAsync('git config user.email "test@example.com"', { cwd: tmpRepoA });
    fs.writeFileSync(path.join(tmpRepoA, "app.js"), "// frontend\n");
    await execAsync("git add . && git commit -m 'Initial frontend'", { cwd: tmpRepoA });

    // リポジトリ B (backend)
    fs.mkdirSync(tmpRepoB, { recursive: true });
    await execAsync("git init -b main", { cwd: tmpRepoB });
    await execAsync('git config user.name "Test"', { cwd: tmpRepoB });
    await execAsync('git config user.email "test@example.com"', { cwd: tmpRepoB });
    fs.writeFileSync(path.join(tmpRepoB, "server.go"), "// backend\n");
    await execAsync("git add . && git commit -m 'Initial backend'", { cwd: tmpRepoB });
  });

  afterAll(() => {
    [tmpBase, tmpRepoA, tmpRepoB].forEach((dir) => {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it("同一チケット配下で複数リポジトリの worktree が正しく共存作成されること", async () => {
    const manager = new GitWorktreeManager(tmpBase);
    const targets = await manager.ensureWorktrees([tmpRepoA, tmpRepoB], "STUDY-3");

    expect(targets).toHaveLength(2);

    const expectedWtA = path.join(tmpBase, "worktrees", "STUDY-3", "test-frontend-repo");
    const expectedWtB = path.join(tmpBase, "worktrees", "STUDY-3", "test-backend-repo");

    expect(path.resolve(targets[0].worktreeDir)).toBe(path.resolve(expectedWtA));
    expect(path.resolve(targets[1].worktreeDir)).toBe(path.resolve(expectedWtB));

    expect(fs.existsSync(expectedWtA)).toBe(true);
    expect(fs.existsSync(expectedWtB)).toBe(true);

    const { stdout: branchA } = await execAsync("git branch --show-current", { cwd: expectedWtA });
    const { stdout: branchB } = await execAsync("git branch --show-current", { cwd: expectedWtB });

    expect(branchA.trim()).toBe("STUDY-3");
    expect(branchB.trim()).toBe("STUDY-3");
  });
});
