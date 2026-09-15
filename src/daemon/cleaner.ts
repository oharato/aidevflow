import fs from "fs";
import path from "path";
import type { IIssueTracker, TrackedIssue } from "../tracker/types.js";
import type { GitWorktreeManager } from "../git/worktree.js";
import type { IGitHubService, PullRequestState } from "../git/github.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import { runCommand } from "../git/exec.js";

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
  orphanDockerProjects?: string[];
}

export interface IssueClientLike {
  getIssue(key: string): Promise<unknown>;
}

export interface ResourceCleanerOptions {
  /** true の場合、削除・停止を実行せずログ出力のみ行う */
  dryRun?: boolean;
}

/**
 * 「完了」「Closed」等、人間がクローズ済みとみなすステータス名か判定する。
 * 「処理済み」（AI 全工程完了・人間 PR レビュー待ち）はクローズではない。
 */
export function isClosedStatusName(statusName: string): boolean {
  const norm = (statusName || "").trim().toLowerCase();
  if (!norm) return false;
  if (norm.includes("処理済")) return false;
  return (
    norm === "完了" ||
    norm === "closed" ||
    norm === "complete" ||
    norm === "completed" ||
    norm.endsWith("完了")
  );
}

export class ResourceCleaner {
  private tracker: IIssueTracker;
  private worktreeManager: GitWorktreeManager;
  private githubService: IGitHubService;
  private logger?: JsonlLogger;
  private dryRun: boolean;

  constructor(
    trackerOrClient: IIssueTracker | IssueClientLike,
    worktreeManager: GitWorktreeManager,
    githubService: IGitHubService,
    logger?: JsonlLogger,
    options: ResourceCleanerOptions = {}
  ) {
    if (trackerOrClient && "trackerType" in trackerOrClient) {
      this.tracker = trackerOrClient;
    } else if (trackerOrClient && typeof trackerOrClient.getIssue === "function") {
      const client = trackerOrClient;
      this.tracker = {
        trackerType: "client-compat",
        init: async () => {},
        fetchActionableIssues: async () => [],
        fetchCandidateIssues: async () => [],
        fetchCompletedIssues: async () => [],
        getIssue: async (key: string): Promise<TrackedIssue> => {
          const raw = await client.getIssue(key);
          if (raw && typeof raw === "object" && "lifecycleState" in raw) {
            return raw as TrackedIssue;
          }
          const rawObj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          const statusObj = rawObj.status as { name?: string } | undefined;
          const statusName =
            (typeof rawObj.rawStatusName === "string" ? rawObj.rawStatusName : undefined) ||
            statusObj?.name ||
            "";
          return {
            key: (typeof rawObj.issueKey === "string" ? rawObj.issueKey : undefined) || key,
            title: (typeof rawObj.summary === "string" ? rawObj.summary : undefined) || (typeof rawObj.title === "string" ? rawObj.title : "") || "",
            rawTitle: (typeof rawObj.summary === "string" ? rawObj.summary : undefined) || (typeof rawObj.rawTitle === "string" ? rawObj.rawTitle : "") || "",
            description: typeof rawObj.description === "string" ? rawObj.description : "",
            lifecycleState: isClosedStatusName(statusName) ? "closed" : "in_progress",
            rawStatusName: statusName,
            recentComments: [],
            isInvestigation: false,
            isFastMode: false,
            updatedAt: (typeof rawObj.updated === "string" ? rawObj.updated : undefined) || new Date().toISOString(),
          };
        },
        updateIssueStep: async () => {},
        updateLifecycle: async () => {},
        addComment: async () => {},
      };
    } else {
      this.tracker = {
        trackerType: "empty",
        init: async () => {},
        fetchActionableIssues: async () => [],
        fetchCandidateIssues: async () => [],
        fetchCompletedIssues: async () => [],
        getIssue: async (key: string) => {
          throw new Error(`[ResourceCleaner] トラッカーが設定されていません: ${key}`);
        },
        updateIssueStep: async () => {},
        updateLifecycle: async () => {},
        addComment: async () => {},
      };
    }
    this.worktreeManager = worktreeManager;
    this.githubService = githubService;
    this.logger = logger;
    this.dryRun = Boolean(options.dryRun);
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * ステータス名から「人間がクローズ済み」かを判定する（「処理済み」は含まない）
   */
  isCompletedStatus(statusName: string): boolean {
    return isClosedStatusName(statusName);
  }

  /**
   * チケットがリソース掃除の対象となる終了状態（人間がクローズ済み）かを判定する。
   * `lifecycleState === "completed"` は「AI 全工程完了・人間 PR レビュー待ち」なので対象外。
   */
  isIssueClosed(issue: TrackedIssue): boolean {
    if (issue.lifecycleState === "closed") return true;
    return isClosedStatusName(issue.rawStatusName || "");
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
        if (this.dryRun) {
          console.log(`[Cleaner] (DRY_RUN) Docker Compose 停止をスキップ: ${file}`);
          stoppedFiles.push(file);
          continue;
        }
        console.log(`[Cleaner] 🛑 Docker Compose コンテナを停止中: ${file}`);
        await runCommand("docker", ["compose", "-f", file, "down", "-v", "--remove-orphans"], {
          cwd: composeDir,
        });
        stoppedFiles.push(file);
        console.log(`[Cleaner] ✅ Docker Compose 停止完了: ${file}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // docker未起動時やコンテナが存在しない場合は警告にとどめる
        console.warn(`[Cleaner] Docker Compose 停止警告 (${file}):`, msg);
      }
    }

    return stoppedFiles;
  }

  /**
   * 指定パスがこのデーモンの worktrees ディレクトリ配下かを判定する
   */
  private isUnderManagedWorktrees(dir: string): boolean {
    const root = path.resolve(this.worktreeManager.getWorktreesDir());
    const resolved = path.resolve(dir);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  /**
   * このデーモンの worktrees 配下のパスで起動されたまま残っている孤児 Docker Compose プロジェクトを停止・削除する。
   *
   * 安全ルール:
   *  - 対象は `getWorktreesDir()` 配下の working_dir を持つプロジェクトのみ（ホスト上の無関係なスタックや
   *    別ユーザー / 別プロジェクトの aidevflow の worktree は触らない）
   *  - チケット照会に失敗した場合は「掃除しない」（削除は取り消せないため、判断不能時は保護側に倒す）
   */
  async cleanOrphanDockerContainers(inFlightIssues: Set<string> = new Set()): Promise<string[]> {
    const stoppedProjects: string[] = [];
    try {
      const { stdout } = await runCommand("docker", [
        "ps",
        "--filter", "label=com.docker.compose.project",
        "--format", '{{.ID}}\t{{index .Labels "com.docker.compose.project"}}\t{{index .Labels "com.docker.compose.project.working_dir"}}',
      ]);
      if (!stdout.trim()) return stoppedProjects;

      const worktreesRoot = path.resolve(this.worktreeManager.getWorktreesDir());
      const lines = stdout.trim().split("\n");
      const projectMap = new Map<string, { workingDir: string; issueKey?: string }>();

      for (const line of lines) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const projectName = parts[1]?.trim();
        const workingDir = parts[2]?.trim();
        if (!projectName || !workingDir) continue;
        if (!this.isUnderManagedWorktrees(workingDir)) continue;

        // <worktreesRoot>/<issueKey>/... からチケットキーを取り出す
        const rel = path.relative(worktreesRoot, path.resolve(workingDir));
        const issueKey = rel.split(path.sep)[0];
        if (!issueKey || issueKey === ".." || issueKey === "") continue;
        projectMap.set(projectName, { workingDir, issueKey });
      }

      for (const [projectName, { workingDir, issueKey }] of projectMap.entries()) {
        if (issueKey && inFlightIssues.has(issueKey)) {
          continue;
        }

        let shouldClean = false;
        if (!fs.existsSync(workingDir)) {
          console.log(`[Cleaner] 🔍 作業ディレクトリが既に存在しない孤児 Docker プロジェクトを検知: ${projectName} (${workingDir})`);
          shouldClean = true;
        } else if (issueKey) {
          try {
            const issue = await this.tracker.getIssue(issueKey);
            shouldClean = this.isIssueClosed(issue);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Cleaner] チケット ${issueKey} の照会に失敗したため Docker プロジェクト ${projectName} は保護します:`, msg);
            shouldClean = false;
          }
        }

        if (shouldClean) {
          if (this.dryRun) {
            console.log(`[Cleaner] (DRY_RUN) 孤児 Docker Compose プロジェクトの停止をスキップ: ${projectName}`);
            stoppedProjects.push(projectName);
            continue;
          }
          console.log(`[Cleaner] 🛑 孤児 Docker Compose プロジェクトを停止・破棄中: ${projectName}`);
          try {
            await runCommand("docker", ["compose", "-p", projectName, "down", "-v", "--remove-orphans"]);
            stoppedProjects.push(projectName);
            console.log(`[Cleaner] ✅ 孤児 Docker Compose 停止完了: ${projectName}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Cleaner] 孤児 Docker Compose 停止警告 (${projectName}):`, msg);
          }
        }
      }
    } catch {
      // docker コマンド非対応環境等は無視
    }

    return stoppedProjects;
  }

  /**
   * 人間がクローズ済み（完了）かつ PR が closed/merged のチケットの worktree と Docker コンテナを一括クリーンアップ
   */
  async cleanupCompletedIssues(
    inFlightIssues: Set<string> = new Set(),
    _projectStatuses?: unknown[]
  ): Promise<CleanupSummary> {
    const orphanDockerProjects = await this.cleanOrphanDockerContainers(inFlightIssues);
    const issueKeys = this.worktreeManager.listIssueKeysWithWorktrees();
    const summary: CleanupSummary = {
      scannedCount: issueKeys.length,
      cleanedCount: 0,
      skippedCount: 0,
      cleanedIssues: [],
      orphanDockerProjects,
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

      // 2. チケットの状態を確認
      let issue: TrackedIssue;
      try {
        issue = await this.tracker.getIssue(issueKey);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // チケット取得失敗時（削除されたチケット等）は安全のためスキップ
        console.warn(`[Cleaner] チケット ${issueKey} の取得失敗によりスキップ:`, msg);
        summary.skippedCount++;
        continue;
      }

      if (!this.isIssueClosed(issue)) {
        // 未クローズのチケット（未対応、処理中、確認待ち、要件レビュー中、処理済み = PR レビュー待ち 等）は絶対にスキップ
        summary.skippedCount++;
        continue;
      }

      // 3. GitHub PR の状態を確認
      //    OPEN → 保護。UNKNOWN（gh 失敗・未認証等）→ 判断不能なので保護。
      //    NOT_FOUND（PR なし: 調査タスク等）/ CLOSED / MERGED → 掃除可
      const worktreeDirs = this.worktreeManager.getIssueWorktreeDirs(issueKey);
      let blockedReason: string | null = null;

      for (const target of worktreeDirs) {
        let prState: PullRequestState = "UNKNOWN";
        try {
          prState = await this.githubService.getPullRequestState(target.worktreeDir, issueKey);
        } catch {
          prState = "UNKNOWN";
        }

        if (prState === "OPEN") {
          blockedReason = `PR が OPEN 中 (${target.repoName})`;
          break;
        }
        if (prState === "UNKNOWN") {
          blockedReason = `PR 状態を確認できません (${target.repoName})`;
          break;
        }
      }

      if (blockedReason) {
        console.log(`[Cleaner] ${issueKey}: チケットは完了ですが ${blockedReason} のためクリーンアップをスキップします`);
        summary.skippedCount++;
        continue;
      }

      // 4. クリーンアップ実行（Docker停止 -> Worktree削除）
      const issueBaseDir = path.join(this.worktreeManager.getWorktreesDir(), issueKey);
      const removedDirs = worktreeDirs.map((t) => t.worktreeDir);

      if (this.dryRun) {
        console.log(`[Cleaner] (DRY_RUN) チケット ${issueKey} のクリーンアップをスキップ (対象: ${removedDirs.join(", ") || issueBaseDir})`);
        summary.skippedCount++;
        continue;
      }

      console.log(`[Cleaner] 🧹 チケット ${issueKey} のクリーンアップを開始します (BTS: 完了, PR: closed/merged/none)`);

      const stoppedDocker = await this.stopDockerCompose(issueBaseDir);
      await this.worktreeManager.removeIssueWorktrees(issueKey);

      const report: CleanedIssueReport = {
        issueKey,
        stoppedDockerServices: stoppedDocker,
        removedWorktreeDirs: removedDirs,
        reason: "Ticket closed and PR closed/merged",
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
