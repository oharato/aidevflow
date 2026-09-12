import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { KeyedAsyncMutex } from "./mutex.js";

const execAsync = promisify(exec);

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

export interface WorktreeTarget {
  repoName: string;
  repoPath: string;
  worktreeDir: string;
  branch: string;
}

export class GitWorktreeManager {
  private baseDir: string;
  private reposDir: string;
  private worktreesDir: string;
  private repoMutex: KeyedAsyncMutex = new KeyedAsyncMutex();

  constructor(customBaseDir?: string) {
    // デフォルト: ~/aidevflow/ (起動ユーザーのホームディレクトリ配下)
    this.baseDir = customBaseDir || process.env.AIDEVFLOW_HOME || path.join(os.homedir(), "aidevflow");
    this.reposDir = path.join(this.baseDir, "repos");
    this.worktreesDir = path.join(this.baseDir, "worktrees");
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getReposDir(): string {
    return this.reposDir;
  }

  getWorktreesDir(): string {
    return this.worktreesDir;
  }

  /**
   * リポジトリURLまたはローカルパスからリポジトリ名を抽出する
   * 例: "git@github.com:org/my-app.git" -> "my-app"
   * 例: "/home/user/workspace/my-service" -> "my-service"
   */
  extractRepoName(repoUrlOrPath: string): string {
    const cleaned = repoUrlOrPath.trim().replace(/\/+$/, "");
    const base = path.basename(cleaned);
    return base.replace(/\.git$/i, "");
  }

  /**
   * リポジトリを ~/aidevflow/repos/<repoName> に準備 (clone または fetch) する
   * (非同期 Mutex により同一リポジトリへの同時操作を排他制御)
   */
  async ensureRepository(repoUrlOrPath: string): Promise<string> {
    const repoName = this.extractRepoName(repoUrlOrPath);
    return this.repoMutex.runExclusive(repoName, async () => {
      return this.ensureRepositoryInternal(repoUrlOrPath, repoName);
    });
  }

  private async ensureRepositoryInternal(repoUrlOrPath: string, repoName: string): Promise<string> {
    if (!fs.existsSync(this.reposDir)) {
      fs.mkdirSync(this.reposDir, { recursive: true });
    }

    const targetRepoPath = path.join(this.reposDir, repoName);

    // すでに clone 済みの場合は状態確認と fetch
    if (fs.existsSync(targetRepoPath)) {
      try {
        await execAsync("git rev-parse --is-inside-work-tree", { cwd: targetRepoPath });
        console.log(`[GitWorktree] 既存のクローンリポジトリを確認: ${targetRepoPath}`);
        await execAsync("git fetch --all --prune", { cwd: targetRepoPath }).catch(() => {});
        return targetRepoPath;
      } catch {
        console.warn(`[GitWorktree] ${targetRepoPath} は破損しているため再クローンします。`);
        fs.rmSync(targetRepoPath, { recursive: true, force: true });
      }
    }

    // 新規 clone
    console.log(`[GitWorktree] リポジトリを clone 中: "${repoUrlOrPath}" -> "${targetRepoPath}"`);
    await execAsync(`git clone "${repoUrlOrPath}" "${targetRepoPath}"`);
    console.log(`[GitWorktree] clone 完了: ${targetRepoPath}`);

    return targetRepoPath;
  }

  /**
   * 単一リポジトリの worktree を作成・準備する
   * 作成パス: ~/aidevflow/worktrees/<issueKey>/<repoName>/
   * ブランチ名: <issueKey>
   * (非同期 Mutex により、同一親リポジトリへの同時 worktree 操作を安全に直列化)
   */
  async ensureWorktree(repoUrlOrPath: string, issueKey: string): Promise<string> {
    const repoName = this.extractRepoName(repoUrlOrPath);

    return this.repoMutex.runExclusive(repoName, async () => {
      const repoPath = await this.ensureRepositoryInternal(repoUrlOrPath, repoName);

      // 1チケットで複数リポジトリがあっても衝突しないよう ~/aidevflow/worktrees/<issueKey>/<repoName>/ に配置
      const issueWorktreeBaseDir = path.join(this.worktreesDir, issueKey);
      if (!fs.existsSync(issueWorktreeBaseDir)) {
        fs.mkdirSync(issueWorktreeBaseDir, { recursive: true });
      }

      const worktreeDir = path.join(issueWorktreeBaseDir, repoName);
      const branchName = issueKey;

      // 既存の worktree 一覧を確認
      const existingWorktrees = await this.listWorktrees(repoPath);
      const existing = existingWorktrees.find(
        (wt) => path.resolve(wt.worktreePath) === path.resolve(worktreeDir)
      );

      if (existing) {
        console.log(`[GitWorktree] 既存の worktree を再利用します: ${worktreeDir} (ブランチ: ${existing.branch})`);
        try {
          await execAsync(`git pull origin "${existing.branch}"`, { cwd: worktreeDir });
        } catch {
          // リモート未プッシュ時やネットワークエラー時はスキップ
        }
        return worktreeDir;
      }

      // ゴーストディレクトリの整理
      await execAsync("git worktree prune", { cwd: repoPath }).catch(() => {});

      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }

      const branchExists = await this.checkBranchExists(repoPath, branchName);

      console.log(`[GitWorktree] 新規 worktree を作成中: パス=${worktreeDir}, ブランチ=${branchName} (新規ブランチ: ${!branchExists})`);

      if (branchExists) {
        await execAsync(`git worktree add "${worktreeDir}" "${branchName}"`, {
          cwd: repoPath,
        });
      } else {
        await execAsync(`git worktree add -b "${branchName}" "${worktreeDir}"`, {
          cwd: repoPath,
        });
      }

      console.log(`[GitWorktree] worktree 作成成功: ${worktreeDir}`);
      return worktreeDir;
    });
  }

  /**
   * 複数リポジトリに対応した一括 worktree 準備
   * 戻り値: 各リポジトリの worktree 情報一覧
   */
  async ensureWorktrees(repoUrlsOrPaths: string[], issueKey: string): Promise<WorktreeTarget[]> {
    const targets: WorktreeTarget[] = [];

    for (const urlOrPath of repoUrlsOrPaths) {
      const repoName = this.extractRepoName(urlOrPath);
      const repoPath = path.join(this.reposDir, repoName);
      const worktreeDir = await this.ensureWorktree(urlOrPath, issueKey);

      targets.push({
        repoName,
        repoPath,
        worktreeDir,
        branch: issueKey,
      });
    }

    return targets;
  }

  private async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", { cwd: repoPath });
      const lines = stdout.split("\n");
      const worktrees: WorktreeInfo[] = [];

      let currentPath = "";
      let currentBranch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentPath = line.substring(9).trim();
        } else if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.substring(18).trim();
        } else if (line === "") {
          if (currentPath) {
            worktrees.push({ worktreePath: currentPath, branch: currentBranch });
          }
          currentPath = "";
          currentBranch = "";
        }
      }
      if (currentPath) {
        worktrees.push({ worktreePath: currentPath, branch: currentBranch });
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  private async checkBranchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`git branch --list "${branchName}"`, { cwd: repoPath });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 現在 worktree が存在するチケットキーの一覧を取得する
   */
  listIssueKeysWithWorktrees(): string[] {
    if (!fs.existsSync(this.worktreesDir)) {
      return [];
    }
    try {
      const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * 特定チケットの配下にある全リポジトリの worktree 情報一覧を取得する
   */
  getIssueWorktreeDirs(issueKey: string): { repoName: string; worktreeDir: string; repoPath: string }[] {
    const issueBaseDir = path.join(this.worktreesDir, issueKey);
    if (!fs.existsSync(issueBaseDir)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(issueBaseDir, { withFileTypes: true });
      const results: { repoName: string; worktreeDir: string; repoPath: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const repoName = entry.name;
          const worktreeDir = path.join(issueBaseDir, repoName);
          const repoPath = path.join(this.reposDir, repoName);
          results.push({ repoName, worktreeDir, repoPath });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * 特定チケットの全 worktree を安全に削除し、親リポジトリを prune してディレクトリを解放する
   */
  async removeIssueWorktrees(issueKey: string): Promise<void> {
    const targets = this.getIssueWorktreeDirs(issueKey);
    const issueBaseDir = path.join(this.worktreesDir, issueKey);

    for (const target of targets) {
      if (fs.existsSync(target.repoPath)) {
        await this.repoMutex.runExclusive(target.repoName, async () => {
          try {
            console.log(`[GitWorktree] worktree を削除中: ${target.worktreeDir}`);
            await execAsync(`git worktree remove --force "${target.worktreeDir}"`, { cwd: target.repoPath }).catch(() => {});
            await execAsync(`git worktree prune`, { cwd: target.repoPath }).catch(() => {});
          } catch (err: any) {
            console.warn(`[GitWorktree] worktree 削除警告 (${target.repoName}):`, err.message);
          }
        });
      }
    }

    if (fs.existsSync(issueBaseDir)) {
      try {
        fs.rmSync(issueBaseDir, { recursive: true, force: true });
        console.log(`[GitWorktree] チケットディレクトリを完全削除: ${issueBaseDir}`);
      } catch (err: any) {
        console.warn(`[GitWorktree] ディレクトリ削除警告 (${issueBaseDir}):`, err.message);
      }
    }
  }
}
