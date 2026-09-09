import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { GitWorktreeManager } from "../src/git/worktree.js";

const execAsync = promisify(exec);

async function runWorktreeTests() {
  console.log("=== GitWorktreeManager (1チケット・複数リポジトリ共存) 単体テスト開始 ===");

  const tmpBase = path.resolve(process.cwd(), "test-aidevflow-multi-home");
  const tmpRepoA = path.resolve(process.cwd(), "test-frontend-repo");
  const tmpRepoB = path.resolve(process.cwd(), "test-backend-repo");

  // クリーンアップ
  [tmpBase, tmpRepoA, tmpRepoB].forEach((dir) => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // リポジトリ A (frontend) 初期化
  fs.mkdirSync(tmpRepoA, { recursive: true });
  await execAsync("git init -b main", { cwd: tmpRepoA });
  await execAsync('git config user.name "Test"', { cwd: tmpRepoA });
  await execAsync('git config user.email "test@example.com"', { cwd: tmpRepoA });
  fs.writeFileSync(path.join(tmpRepoA, "app.js"), "// frontend\n");
  await execAsync("git add . && git commit -m 'Initial frontend'", { cwd: tmpRepoA });

  // リポジトリ B (backend) 初期化
  fs.mkdirSync(tmpRepoB, { recursive: true });
  await execAsync("git init -b main", { cwd: tmpRepoB });
  await execAsync('git config user.name "Test"', { cwd: tmpRepoB });
  await execAsync('git config user.email "test@example.com"', { cwd: tmpRepoB });
  fs.writeFileSync(path.join(tmpRepoB, "server.go"), "// backend\n");
  await execAsync("git add . && git commit -m 'Initial backend'", { cwd: tmpRepoB });

  const manager = new GitWorktreeManager(tmpBase);

  // 1つのチケット STUDY-3 で両方のリポジトリの worktree を作成
  console.log("テスト: チケット STUDY-3 で複数リポジトリを一括準備");
  const targets = await manager.ensureWorktrees([tmpRepoA, tmpRepoB], "STUDY-3");

  if (targets.length !== 2) {
    throw new Error(`対象数が一致しません: ${targets.length}`);
  }

  const expectedWtA = path.join(tmpBase, "worktrees", "STUDY-3", "test-frontend-repo");
  const expectedWtB = path.join(tmpBase, "worktrees", "STUDY-3", "test-backend-repo");

  if (path.resolve(targets[0].worktreeDir) !== path.resolve(expectedWtA)) {
    throw new Error(`リポジトリAのパス不一致: ${targets[0].worktreeDir}`);
  }
  if (path.resolve(targets[1].worktreeDir) !== path.resolve(expectedWtB)) {
    throw new Error(`リポジトリBのパス不一致: ${targets[1].worktreeDir}`);
  }

  // 両方のディレクトリとブランチ名が存在・共存しているか確認
  if (!fs.existsSync(expectedWtA) || !fs.existsSync(expectedWtB)) {
    throw new Error("worktree ディレクトリが共存していません");
  }

  const { stdout: branchA } = await execAsync("git branch --show-current", { cwd: expectedWtA });
  const { stdout: branchB } = await execAsync("git branch --show-current", { cwd: expectedWtB });

  if (branchA.trim() !== "STUDY-3" || branchB.trim() !== "STUDY-3") {
    throw new Error(`ブランチ名がSTUDY-3ではありません: A=${branchA}, B=${branchB}`);
  }

  console.log("✓ リポジトリA (frontend) worktree:", expectedWtA, `(ブランチ: ${branchA.trim()})`);
  console.log("✓ リポジトリB (backend) worktree:", expectedWtB, `(ブランチ: ${branchB.trim()})`);
  console.log("✓ 同一チケットSTUDY-3配下での複数リポジトリ共存検証に成功！");

  // クリーンアップ
  [tmpBase, tmpRepoA, tmpRepoB].forEach((dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log("✓ GitWorktreeManager 全テスト合格！");
}

runWorktreeTests().catch((err) => {
  console.error("Worktree テスト失敗:", err);
  process.exit(1);
});
