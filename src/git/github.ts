import fs from "fs";
import os from "os";
import path from "path";
import { runCommand, isSafeRefName } from "./exec.js";

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
   *
   * チケットの件名・本文は外部入力なので、シェル文字列に埋め込まず execFile の引数配列 /
   * 一時ファイル（--body-file）として渡す。
   */
  async ensurePullRequest(
    worktreeDir: string,
    options: CreatePullRequestOptions
  ): Promise<string | null> {
    if (options.dryRun) {
      console.log(`[GitHub] (DRY_RUN) PR作成をシミュレート: ブランチ=${options.issueKey}`);
      return `https://github.com/mock-org/mock-repo/pull/999`;
    }

    const branchName = options.issueKey;
    if (!isSafeRefName(branchName)) {
      console.error(`[GitHub] 安全でないブランチ名のため PR 作成を中止しました: "${branchName}"`);
      return null;
    }
    if (options.baseBranch && !isSafeRefName(options.baseBranch)) {
      console.error(`[GitHub] 安全でないベースブランチ名のため PR 作成を中止しました: "${options.baseBranch}"`);
      return null;
    }

    try {
      const { stdout: remotes } = await runCommand("git", ["remote"], { cwd: worktreeDir });
      if (!remotes.trim()) {
        console.warn(`[GitHub] リモートリポジトリが設定されていないため、PR作成をスキップします: ${worktreeDir}`);
        return null;
      }

      console.log(`[GitHub] ブランチ "${branchName}" を origin に push 中 (${worktreeDir})...`);
      try {
        // リモートが先行している場合は事前に fast-forward pull を試みる
        await runCommand("git", ["pull", "--ff-only", "origin", branchName], { cwd: worktreeDir }).catch(() => {});
        await runCommand("git", ["push", "-u", "origin", branchName], { cwd: worktreeDir });
      } catch (pushErr: unknown) {
        const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        console.warn(`[GitHub] git push 警告: ${msg}`);
      }

      try {
        const { stdout: existingUrl } = await runCommand(
          "gh",
          ["pr", "view", branchName, "--json", "url", "-q", ".url"],
          { cwd: worktreeDir }
        );
        if (existingUrl && existingUrl.trim().startsWith("http")) {
          const prUrl = existingUrl.trim();
          console.log(`[GitHub] 既存のプルリクエストを検出: ${prUrl}`);
          return prUrl;
        }
      } catch {
        // 新規作成へ
      }

      const prTitle = `[${options.issueKey}] ${options.summary}`.replace(/[\r\n]+/g, " ").slice(0, 250);
      const prBody = [
        `## 概要`,
        options.summary,
        ``,
        `## 関連課題 (Issue)`,
        `課題キー: ${options.issueKey}`,
        ``,
        `## 詳細・背景`,
        options.description,
        ``,
        `---`,
        `*🤖 Generated automatically by aidevflow (AI Agent Pipeline)*`,
      ].join("\n");

      console.log(`[GitHub] 新規 PR を作成中: "${prTitle}"...`);

      const bodyFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-pr-")),
        "body.md"
      );
      try {
        fs.writeFileSync(bodyFile, prBody, { encoding: "utf8", mode: 0o600 });
        const args = [
          "pr", "create",
          "--title", prTitle,
          "--body-file", bodyFile,
          "--head", branchName,
        ];
        if (options.baseBranch) {
          args.push("--base", options.baseBranch);
        }
        const { stdout: createdUrl } = await runCommand("gh", args, { cwd: worktreeDir });
        const prUrl = createdUrl.trim();
        console.log(`[GitHub] プルリクエスト作成成功: ${prUrl}`);
        return prUrl;
      } finally {
        fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[GitHub] PR 作成エラー:`, msg);
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
    if (branchName && !isSafeRefName(branchName)) {
      return "UNKNOWN";
    }
    try {
      const args = ["pr", "view"];
      if (branchName) args.push(branchName);
      args.push("--json", "state", "-q", ".state");
      const { stdout } = await runCommand("gh", args, { cwd: worktreeDir });
      const state = stdout.trim().toUpperCase();
      if (state === "OPEN" || state === "CLOSED" || state === "MERGED") {
        return state;
      }
      return "UNKNOWN";
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (msg.includes("no pull requests found") || msg.includes("could not resolve to a pullrequest")) {
        return "NOT_FOUND";
      }
      return "UNKNOWN";
    }
  }
}
