import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface CreatePullRequestOptions {
  issueKey: string;
  summary: string;
  description: string;
  baseBranch?: string;
  dryRun?: boolean;
}

export interface PullRequestResult {
  repoName: string;
  prUrl: string;
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED" | "NOT_FOUND" | "UNKNOWN";

export interface IGitHubService {
  ensurePullRequest(worktreeDir: string, options: CreatePullRequestOptions): Promise<string | null>;
  ensurePullRequests(
    worktreeTargets: { repoName: string; worktreeDir: string }[],
    options: CreatePullRequestOptions
  ): Promise<PullRequestResult[]>;
  getPullRequestState(worktreeDir: string, branchName?: string): Promise<PullRequestState>;
}

export class GitHubService implements IGitHubService {
  /**
   * 対象の worktree ディレクトリ内でブランチを push し、GitHub PR を作成または既存 PR の URL を取得する
   */
  async ensurePullRequest(
    worktreeDir: string,
    options: CreatePullRequestOptions
  ): Promise<string | null> {
    if (options.dryRun) {
      console.log(`[GitHub] (DRY_RUN) PR作成をシミュレート: ブランチ=${options.issueKey}`);
      return `https://github.com/mock-org/mock-repo/pull/999`;
    }

    try {
      const { stdout: remotes } = await execAsync("git remote", { cwd: worktreeDir });
      if (!remotes.trim()) {
        console.warn(`[GitHub] リモートリポジトリが設定されていないため、PR作成をスキップします: ${worktreeDir}`);
        return null;
      }

      const branchName = options.issueKey;

      console.log(`[GitHub] ブランチ "${branchName}" を origin に push 中 (${worktreeDir})...`);
      try {
        // リモートが先行している場合は事前に fast-forward pull を試みる
        await execAsync(`git pull --ff-only origin "${branchName}"`, { cwd: worktreeDir }).catch(() => {});
        await execAsync(`git push -u origin "${branchName}"`, { cwd: worktreeDir });
      } catch (pushErr: any) {
        console.warn(`[GitHub] git push 警告: ${pushErr.message}`);
      }

      try {
        const { stdout: existingUrl } = await execAsync("gh pr view --json url -q .url", {
          cwd: worktreeDir,
        });
        if (existingUrl && existingUrl.trim().startsWith("http")) {
          const prUrl = existingUrl.trim();
          console.log(`[GitHub] 既存のプルリクエストを検出: ${prUrl}`);
          return prUrl;
        }
      } catch {
        // 新規作成へ
      }

      const prTitle = `[${options.issueKey}] ${options.summary}`;
      const prBody = [
        `## 概要`,
        options.summary,
        ``,
        `## Backlog チケット`,
        `課題キー: ${options.issueKey}`,
        ``,
        `## 詳細・背景`,
        options.description,
        ``,
        `---`,
        `*🤖 Generated automatically by aidevflow (AI Agent Pipeline)*`,
      ].join("\n");

      const baseArg = options.baseBranch ? `--base "${options.baseBranch}"` : "";
      console.log(`[GitHub] 新規 PR を作成中: "${prTitle}"...`);

      const cmd = `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --head "${branchName}" ${baseArg}`;
      const { stdout: createdUrl } = await execAsync(cmd, { cwd: worktreeDir });

      const prUrl = createdUrl.trim();
      console.log(`[GitHub] プルリクエスト作成成功: ${prUrl}`);
      return prUrl;
    } catch (err: any) {
      console.error(`[GitHub] PR 作成エラー:`, err.message);
      return null;
    }
  }

  /**
   * 複数リポジトリの一括 PR 準備
   */
  async ensurePullRequests(
    worktreeTargets: { repoName: string; worktreeDir: string }[],
    options: CreatePullRequestOptions
  ): Promise<PullRequestResult[]> {
    const results: PullRequestResult[] = [];

    for (const target of worktreeTargets) {
      const prUrl = await this.ensurePullRequest(target.worktreeDir, options);
      if (prUrl) {
        results.push({
          repoName: target.repoName,
          prUrl,
        });
      }
    }

    return results;
  }

  /**
   * 対象の worktree またはブランチの PR 状態（OPEN, CLOSED, MERGED 等）を取得する
   */
  async getPullRequestState(worktreeDir: string, branchName?: string): Promise<PullRequestState> {
    try {
      const branchArg = branchName ? `"${branchName}"` : "";
      const cmd = `gh pr view ${branchArg} --json state -q .state`;
      const { stdout } = await execAsync(cmd, { cwd: worktreeDir });
      const state = stdout.trim().toUpperCase();
      if (state === "OPEN" || state === "CLOSED" || state === "MERGED") {
        return state;
      }
      return "UNKNOWN";
    } catch (err: any) {
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("no pull requests found") || msg.includes("could not resolve to a pullrequest")) {
        return "NOT_FOUND";
      }
      return "UNKNOWN";
    }
  }
}
