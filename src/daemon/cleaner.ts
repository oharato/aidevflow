import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { BacklogClient } from "../backlog/client.js";
import type { GitWorktreeManager } from "../git/worktree.js";
import type { IGitHubService, PullRequestState } from "../git/github.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import type { BacklogStatus } from "../backlog/types.js";

const execAsync = promisify(exec);

export interface CleanedIssueReport {
  issueKey: string;
  stoppedDockerServices: string[];
  removedWorktreeDirs: string[];
  reason: string;
}

export interface CleanupSummary {
  scannedCount: number;
  cleanedCount: number;
  skippedCount: number;
  cleanedIssues: CleanedIssueReport[];
}

export class ResourceCleaner {
  private backlog: BacklogClient;
  private worktreeManager: GitWorktreeManager;
  private githubService: IGitHubService;
  private logger?: JsonlLogger;

  constructor(
    backlog: BacklogClient,
    worktreeManager: GitWorktreeManager,
    githubService: IGitHubService,
    logger?: JsonlLogger
  ) {
    this.backlog = backlog;
    this.worktreeManager = worktreeManager;
    this.githubService = githubService;
    this.logger = logger;
  }

  /**
   * ステータス名から完了状態かを判定する
   */
  isCompletedStatus(statusName: string): boolean {
    const norm = statusName.trim().toLowerCase();
    return (
      norm === "完了" ||
      norm === "closed" ||
      norm === "complete" ||
      norm === "completed" ||
      norm.endsWith("完了")
    );
  }

  /**
   * 指定ディレクトリ配下の docker-compose ファイルを探して停止する
   */
  async stopDockerCompose(targetDir: string): Promise<string[]> {
    const stoppedFiles: string[] = [];
    if (!fs.existsSync(targetDir)) return stoppedFiles;

    const composeNames = [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ];

    const findComposeFiles = (dir: string, depth: number = 0): string[] => {
      if (depth > 2) return [];
      const found: string[] = [];
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (entry.name !== ".git" && entry.name !== "node_modules") {
              found.push(...findComposeFiles(path.join(dir, entry.name), depth + 1));
            }
          } else if (composeNames.includes(entry.name.toLowerCase())) {
            found.push(path.join(dir, entry.name));
          }
        }
      } catch {
        // アクセス権限エラー等の場合は無視
      }
      return found;
    };

    const composeFiles = findComposeFiles(targetDir);

    for (const file of composeFiles) {
      const composeDir = path.dirname(file);
      try {
        console.log(`[Cleaner] 🛑 Docker Compose コンテナを停止中: ${file}`);
        await execAsync(`docker compose -f "${file}" down -v --remove-orphans`, {
          cwd: composeDir,
        });
        stoppedFiles.push(file);
        console.log(`[Cleaner] ✅ Docker Compose 停止完了: ${file}`);
      } catch (err: any) {
        // docker未起動時やコンテナが存在しない場合は警告にとどめる
        console.warn(`[Cleaner] Docker Compose 停止警告 (${file}):`, err.message);
      }
    }

    return stoppedFiles;
  }

  /**
   * 完了済みかつPRがclose/mergedのチケットのworktreeとDockerコンテナを一括クリーンアップ
   */
  async cleanupCompletedIssues(
    inFlightIssues: Set<string> = new Set(),
    projectStatuses?: BacklogStatus[]
  ): Promise<CleanupSummary> {
    const issueKeys = this.worktreeManager.listIssueKeysWithWorktrees();
    const summary: CleanupSummary = {
      scannedCount: issueKeys.length,
      cleanedCount: 0,
      skippedCount: 0,
      cleanedIssues: [],
    };

    if (issueKeys.length === 0) {
      return summary;
    }

    for (const issueKey of issueKeys) {
      // 1. 実行中のチケットは絶対に削除しない
      if (inFlightIssues.has(issueKey)) {
        summary.skippedCount++;
        continue;
      }

      // 2. Backlog チケットの状態を確認
      let issue;
      try {
        issue = await this.backlog.getIssue(issueKey);
      } catch (err: any) {
        // チケット取得失敗時（削除されたチケット等）は安全のためスキップ
        console.warn(`[Cleaner] チケット ${issueKey} の取得失敗によりスキップ:`, err.message);
        summary.skippedCount++;
        continue;
      }

      let isDone = this.isCompletedStatus(issue.status.name);
      if (!isDone && projectStatuses) {
        const matchingStatus = projectStatuses.find((s) => s.id === issue.status.id);
        if (matchingStatus && this.isCompletedStatus(matchingStatus.name)) {
          isDone = true;
        }
      }

      if (!isDone) {
        // 未完了のチケット（未対応、処理中、確認待ち、要件レビュー中、処理済み等）は絶対にスキップ
        summary.skippedCount++;
        continue;
      }

      // 3. GitHub PR の状態を確認
      const worktreeDirs = this.worktreeManager.getIssueWorktreeDirs(issueKey);
      let allPrsClosed = true;
      let hasOpenPr = false;

      for (const target of worktreeDirs) {
        let prState: PullRequestState = "UNKNOWN";
        try {
          prState = await this.githubService.getPullRequestState(target.worktreeDir, issueKey);
        } catch {
          prState = "UNKNOWN";
        }

        if (prState === "OPEN") {
          hasOpenPr = true;
          allPrsClosed = false;
          break;
        }
      }

      // PR がオープン中の場合はクリーンアップしてはいけない
      if (hasOpenPr || !allPrsClosed) {
        console.log(`[Cleaner] ${issueKey}: チケットは完了ですがPRがOPEN中のためクリーンアップをスキップします`);
        summary.skippedCount++;
        continue;
      }

      // 4. クリーンアップ実行（Docker停止 -> Worktree削除）
      console.log(`[Cleaner] 🧹 チケット ${issueKey} のクリーンアップを開始します (Backlog: 完了, PR: closed/merged)`);

      const issueBaseDir = path.join(this.worktreeManager.getWorktreesDir(), issueKey);
      const stoppedDocker = await this.stopDockerCompose(issueBaseDir);
      const removedDirs = worktreeDirs.map((t) => t.worktreeDir);

      await this.worktreeManager.removeIssueWorktrees(issueKey);

      const report: CleanedIssueReport = {
        issueKey,
        stoppedDockerServices: stoppedDocker,
        removedWorktreeDirs: removedDirs,
        reason: "Ticket completed and PR closed/merged",
      };

      summary.cleanedCount++;
      summary.cleanedIssues.push(report);

      console.log(`[Cleaner] 🎉 チケット ${issueKey} のクリーンアップが完了しました (Worktree: ${removedDirs.length}件, Docker: ${stoppedDocker.length}件)`);

      this.logger?.info(
        "cleanup_completed",
        `完了チケット ${issueKey} のリソースクリーンアップ完了`,
        {
          issueKey,
          data: {
            stoppedDockerServices: stoppedDocker,
            removedWorktreeDirs: removedDirs,
          },
        }
      );
    }

    return summary;
  }
}
