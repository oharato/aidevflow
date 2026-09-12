import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import type { BacklogClient } from "../backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../backlog/types.js";
import type { IAgentRunner, AgentRole, AgentContext } from "../agents/types.js";
import { TokenUsageTracker } from "../agents/runner.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import { extractRepositoryPaths } from "../git/repo-parser.js";
import { GitWorktreeManager, type WorktreeTarget } from "../git/worktree.js";
import { GitHubService, type PullRequestResult } from "../git/github.js";
import {
  hasCustomStatuses,
  parsePhaseFromSummary,
  formatSummaryWithPhase,
  getNextPhaseTag,
  PHASE_TAGS,
  isInvestigationIssue,
  isFastModeIssue,
} from "../backlog/prefix-helper.js";
import { QuotaLockManager, parseResetDuration } from "./quota-lock.js";

export interface ProcessIssueResult {
  handled: boolean;
  nextStatusTarget?: string;
  isEscalation?: boolean;
  rejectionCount?: number;
  newSummary?: string;
  isQuota?: boolean;
}

/**
 * エージェントの出力から人間への明示的な確認依頼（エスカレーション）が含まれているかを判定する。
 * 「〜（CONFIRM_HUMAN）もございません」「【人間への確認依頼】はありません」「不要」などの否定表現や、
 * 承認（LGTM）報告時の誤検知を防止する。
 */
export function hasHumanEscalationRequest(output: string): boolean {
  if (!output) return false;

  // 1. 否定文脈・不要宣言にマッチするパターンを除去
  const negativePatterns = [
    /(?:【人間への確認依頼】|CONFIRM_HUMAN)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
    /(?:必要|事項|エスカレーション)[^。\n]*?(?:【人間への確認依頼】|CONFIRM_HUMAN)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
  ];

  let sanitized = output;
  for (const pattern of negativePatterns) {
    sanitized = sanitized.replace(pattern, "");
  }

  // 2. 明示的な確認要請キーワードの存在確認
  return (
    sanitized.includes("【人間への確認依頼】") ||
    sanitized.includes("CONFIRM_HUMAN")
  );
}

export class AgentDispatcher {
  private backlog: BacklogClient;
  private runner: IAgentRunner;
  private defaultRepoPath: string;
  private dryRun: boolean;
  private logger?: JsonlLogger;
  private worktreeManager: GitWorktreeManager;
  private githubService: GitHubService;
  private maxRejectionCount: number;
  private rejectionCounts: Map<string, number> = new Map();
  private lastRoleMap: Map<string, AgentRole> = new Map();
  private customStatusModeOverride?: boolean;
  private quotaLockManager?: QuotaLockManager;

  constructor(
    backlog: BacklogClient,
    runner: IAgentRunner,
    defaultRepoPath: string,
    dryRun: boolean = false,
    logger?: JsonlLogger,
    worktreeManager?: GitWorktreeManager,
    githubService?: GitHubService,
    maxRejectionCount: number = 3,
    customStatusModeOverride?: boolean,
    quotaLockManager?: QuotaLockManager
  ) {
    this.backlog = backlog;
    this.runner = runner;
    this.defaultRepoPath = defaultRepoPath;
    this.dryRun = dryRun;
    this.logger = logger;
    this.worktreeManager = worktreeManager || new GitWorktreeManager();
    this.githubService = githubService || new GitHubService();
    this.maxRejectionCount = maxRejectionCount;
    this.customStatusModeOverride = customStatusModeOverride;
    this.quotaLockManager = quotaLockManager;
  }

  setQuotaLockManager(manager?: QuotaLockManager): void {
    this.quotaLockManager = manager;
  }

  getQuotaLockManager(): QuotaLockManager | undefined {
    return this.quotaLockManager;
  }

  getRunner(): IAgentRunner {
    return this.runner;
  }

  getWorktreeManager(): GitWorktreeManager {
    return this.worktreeManager;
  }

  getGitHubService(): GitHubService {
    return this.githubService;
  }

  setCustomStatusMode(enabled?: boolean): void {
    this.customStatusModeOverride = enabled;
  }

  isCustomStatusMode(projectStatuses: BacklogStatus[]): boolean {
    if (this.customStatusModeOverride !== undefined) {
      return this.customStatusModeOverride;
    }
    return hasCustomStatuses(projectStatuses);
  }

  getRejectionCount(issueKey: string): number {
    return this.rejectionCounts.get(issueKey) || 0;
  }

  resetRejectionCount(issueKey: string): void {
    this.rejectionCounts.delete(issueKey);
  }

  resolveRole(issue: BacklogIssue, projectStatuses: BacklogStatus[]): AgentRole | null {
    if (this.isCustomStatusMode(projectStatuses)) {
      return this.resolveRoleFromStatus(issue.status.name);
    }
    return this.resolveRoleFromSummary(issue);
  }

  resolveRoleFromSummary(issue: BacklogIssue): AgentRole | null {
    const statusName = issue.status.name;
    // プレフィックスモードでは「処理中」または「未対応」を対象とする
    if (!statusName.includes("処理中") && !statusName.includes("未対応")) {
      return null;
    }

    const parsed = parsePhaseFromSummary(issue.summary);

    // [確認待ち] タグが付いている場合:
    if (parsed.isWaitingConfirmation) {
      // 人間確認待ちの間（未対応）はスキップ
      if (statusName.includes("未対応")) {
        return null;
      }
      // 人間が回答してステータスを「処理中」に変更した場合は再開
      // 直前のロールがあればそれを再開ロールとし、なければデフォルト "spec-writer"
      return this.lastRoleMap.get(issue.issueKey) || "spec-writer";
    }

    // [要件レビュー完了] または [調査完了] の場合:
    if (parsed.isCompleted) {
      // 人間がレビュー後に差し戻してステータスを「処理中」に変更した場合:
      // 調査タスクなら再調査・設計修正 (spec-writer)、実装タスクなら実装修正 (developer) を再開
      if (statusName.includes("処理中")) {
        const isInvestigation = isInvestigationIssue(issue);
        return isInvestigation ? "spec-writer" : "developer";
      }
      return null;
    }

    if (parsed.role) {
      return parsed.role;
    }

    // タグがなく「処理中」になっている場合:
    // Fastモードなら初期ロールは developer (実装)、それ以外は spec-writer (詳細仕様策定)
    if (statusName.includes("処理中")) {
      const isFast = isFastModeIssue(issue);
      return isFast ? "developer" : "spec-writer";
    }

    return null;
  }

  resolveRoleFromStatus(statusName: string): AgentRole | null {
    const s = statusName.toLowerCase();

    // 1. 詳細仕様策定 / 詳細設計 / 調査 (spec-writer)
    if (s.includes("詳細設計") || s.includes("設計中") || s.includes("調査中") || s.includes("spec-writer") || s.includes("architect") || s.includes("director")) {
      return "spec-writer";
    }

    // 2. 詳細仕様レビュー / 設計レビュー / 調査レビュー (spec-reviewer)
    if (s.includes("設計レビュー") || s.includes("調査レビュー") || s.includes("spec-reviewer") || s.includes("tech-lead") || s.includes("curator")) {
      return "spec-reviewer";
    }

    // 3. 実装 (developer)
    if (s.includes("実装") || s.includes("developer") || s.includes("artist")) {
      return "developer";
    }

    // 4. 技術的観点レビュー (code-reviewer)
    if (s.includes("技術レビュー") || s.includes("code-reviewer") || s.includes("critic")) {
      return "code-reviewer";
    }

    // 5. 要件的観点レビュー (requirement-reviewer)
    if (s.includes("要件レビュー") || s.includes("requirement-reviewer") || s.includes("qa") || s.includes("editor")) {
      return "requirement-reviewer";
    }

    return null;
  }

  getNextStatusName(
    currentRole: AgentRole,
    isRejection: boolean,
    isInvestigation: boolean = false,
    isFastMode: boolean = false
  ): string {
    if (isRejection) {
      switch (currentRole) {
        case "spec-reviewer":
          return "詳細設計";
        case "code-reviewer":
        case "requirement-reviewer":
          return "実装";
        default:
          return "未対応";
      }
    }

    switch (currentRole) {
      case "spec-writer":
        return "設計レビュー";
      case "spec-reviewer":
        return isInvestigation ? "完了" : "実装";
      case "developer":
        return "技術レビュー";
      case "code-reviewer":
        return isFastMode ? "完了" : "要件レビュー";
      case "requirement-reviewer":
        return "完了";
    }
  }

  findStatusIdByName(statuses: BacklogStatus[], targetName: string): number | null {
    const targetLower = targetName.toLowerCase();
    const exact = statuses.find((st) => st.name.toLowerCase() === targetLower);
    if (exact) return exact.id;

    const partial = statuses.find((st) => st.name.toLowerCase().includes(targetLower));
    if (partial) return partial.id;

    return null;
  }

  /**
   * PR作成後・レビュー完了時に、人間が手元で動作確認（検証）するための手順案内を生成する
   */
  generateVerificationGuide(
    worktreeTargets: WorktreeTarget[],
    executionWorkDir: string,
    issueKey: string
  ): string[] {
    const lines: string[] = [
      `#### 🚀 手元での動作確認（ローカル検証）手順 & 要件受入コマンド:`,
      `本チケットの要件が正しく満たされているか、手元で確認・受入検証を行うための具体的な手順とコマンドです：`,
      ``,
    ];

    if (worktreeTargets.length === 1) {
      const target = worktreeTargets[0];
      const dir = target.worktreeDir;
      lines.push(`1. **ワークツリーへ移動 & 最新コードの同期**:`);
      lines.push(`   \`\`\`bash`);
      lines.push(`   cd ${dir}`);
      lines.push(`   git pull origin "${issueKey}"`);
      lines.push(`   \`\`\``);
      lines.push(``);

      lines.push(`2. **コミット履歴 & 実装差分の確認 (要件との照合)**:`);
      lines.push(`   \`\`\`bash`);
      lines.push(`   # 直近のコミット一覧（要件に沿った実装内容）の確認`);
      lines.push(`   git log -n 5 --oneline`);
      lines.push(`   # 変更ファイルと差分統計の確認`);
      lines.push(`   git diff origin/main..HEAD --stat`);
      lines.push(`   # 必要に応じて詳細差分を確認`);
      lines.push(`   git diff origin/main..HEAD`);
      lines.push(`   \`\`\``);
      lines.push(``);

      // プロジェクト構成の検知
      const hasDockerCompose =
        fs.existsSync(path.join(dir, "docker-compose.yml")) ||
        fs.existsSync(path.join(dir, "docker-compose.yaml")) ||
        fs.existsSync(path.join(dir, "compose.yaml")) ||
        fs.existsSync(path.join(dir, "compose.yml"));

      const hasPackageJson = fs.existsSync(path.join(dir, "package.json"));
      const hasFrontendPackageJson = fs.existsSync(path.join(dir, "frontend", "package.json"));
      const hasBackendRequirements = fs.existsSync(path.join(dir, "backend", "requirements.txt"));
      const hasRootRequirements = fs.existsSync(path.join(dir, "requirements.txt"));

      lines.push(`3. **自動テスト & ビルドによる品質検証**:`);
      lines.push(`   \`\`\`bash`);
      if (hasPackageJson) {
        lines.push(`   # 依存関係のインストール`);
        lines.push(`   pnpm install`);
        lines.push(`   # 単体テスト・結合テストの実行`);
        lines.push(`   pnpm test`);
        lines.push(`   # 型チェック & ビルド検証`);
        lines.push(`   pnpm run build`);
      } else if (hasRootRequirements) {
        lines.push(`   pytest`);
      } else {
        lines.push(`   # プロジェクト規定のテストを実行`);
        lines.push(`   make test`);
      }
      lines.push(`   \`\`\``);
      lines.push(``);

      lines.push(`4. **ローカル起動 & 動作確認 (要件受入チェック)**:`);
      lines.push(`   \`\`\`bash`);
      if (hasDockerCompose) {
        lines.push(`   # コンテナ一括起動`);
        lines.push(`   docker compose up -d --build`);
        lines.push(`   # ログ確認`);
        lines.push(`   docker compose logs -f`);
      } else if (hasPackageJson) {
        lines.push(`   pnpm dev`);
      } else if (hasRootRequirements) {
        lines.push(`   source .venv/bin/activate && python main.py`);
      }
      lines.push(`   \`\`\``);

      if (hasDockerCompose) {
        lines.push(`   - 停止時: \`docker compose down\``);
      }
      if (hasFrontendPackageJson && !hasDockerCompose) {
        lines.push(`   - **フロントエンド起動**: \`cd frontend && pnpm dev\``);
      }
      if (hasBackendRequirements && !hasDockerCompose) {
        lines.push(`   - **バックエンド起動**: \`cd backend && pip install -r requirements.txt && python app.py\``);
      }
      lines.push(`   - **受入確認ポイント**: チケットに記載された要件（新機能、UI表示、APIレスポンス等）が仕様通り動作することをご確認ください。`);
      if (fs.existsSync(path.join(dir, "README.md"))) {
        lines.push(`   - 💡 *ポート番号やAPIエンドポイント等の詳細はリポジトリ内の \`README.md\` もご参照ください。*`);
      }
    } else if (worktreeTargets.length > 1) {
      lines.push(`1. **各リポジトリのワークツリーへ移動 & 最新コードの同期**:`);
      for (const target of worktreeTargets) {
        lines.push(`   - **${target.repoName}**:`);
        lines.push(`     \`\`\`bash`);
        lines.push(`     cd ${target.worktreeDir}`);
        lines.push(`     git pull origin "${issueKey}"`);
        lines.push(`     git log -n 3 --oneline`);
        lines.push(`     git diff origin/main..HEAD --stat`);
        lines.push(`     \`\`\``);
      }
      lines.push(`2. **各サービスのテスト・ビルド・起動コマンドを実行し、サービス間連携および要件の動作をご確認ください。**`);
    } else {
      lines.push(`1. **作業ディレクトリへ移動 & 最新コードの同期**:`);
      lines.push(`   \`\`\`bash`);
      lines.push(`   cd ${executionWorkDir}`);
      lines.push(`   git pull origin "${issueKey}"`);
      lines.push(`   git log -n 5 --oneline`);
      lines.push(`   git diff origin/main..HEAD --stat`);
      lines.push(`   \`\`\``);
      lines.push(`2. **テストを実行して要件の動作をご確認ください。**`);
    }

    lines.push(``);
    lines.push(`5. **確認後の対応アクション**:`);
    lines.push(`   - **【要件通りで問題ない場合 (完了・マージ)】**:`);
    lines.push(`     1. GitHub 上でプルリクエストをマージしてください。`);
    lines.push(`     2. 本チケットのステータスを **「完了」** に変更してください。`);
    lines.push(`   - **【修正や追加要望がある場合 (AIに再修正させる)】**:`);
    lines.push(`     1. 本チケットのコメント欄に具体的な修正指示・指摘を記入してください。`);
    lines.push(`     2. ステータスを **「処理中」** に変更してください（AI エージェントが自動で修正コミットを作成して PR に push します）。`);

    return lines;
  }

  async processIssue(issue: BacklogIssue, projectStatuses: BacklogStatus[]): Promise<ProcessIssueResult> {
    const statusName = issue.status.name;
    const role = this.resolveRole(issue, projectStatuses);

    if (!role) {
      return { handled: false };
    }

    console.log(`\n----------------------------------------`);
    console.log(`[Dispatcher] 課題検知: ${issue.issueKey} [${issue.summary}]`);
    console.log(`[Dispatcher] 現在のステータス: "${statusName}" -> 担当エージェント: [${role}]`);
    console.log(`----------------------------------------`);

    this.logger?.info("issue_detected", `課題検知: ${issue.issueKey} (${statusName})`, {
      issueKey: issue.issueKey,
      role,
      data: { summary: issue.summary, status: statusName },
    });

    // 1. チケット詳細から1つまたは複数のリポジトリパス/URLを抽出
    const rawRepoPaths = extractRepositoryPaths(issue.description, this.defaultRepoPath);
    if (rawRepoPaths.length === 0) {
      const errMsg = `リポジトリ情報をチケット詳細から検出できず、フォールバック設定もありません。詳細に「リポジトリ: <URLまたはパス>」を記載してください。`;
      console.error(`[Dispatcher] エラー: ${errMsg}`);
      this.logger?.error("error", errMsg, { issueKey: issue.issueKey, role });
      await this.backlog.addComment(issue.issueKey, `⚠️ **エラー**: ${errMsg}`).catch(() => {});
      return { handled: false };
    }

    console.log(`[Dispatcher] 対象リポジトリ (${rawRepoPaths.length}件):`, rawRepoPaths);

    // 2. git worktree を準備 (~/aidevflow/worktrees/<issueKey>/<repoName>)
    let worktreeTargets: WorktreeTarget[] = [];
    let executionWorkDir = "";

    try {
      worktreeTargets = await this.worktreeManager.ensureWorktrees(rawRepoPaths, issue.issueKey);

      if (worktreeTargets.length === 1) {
        // 単一リポジトリの場合はその worktree ディレクトリを直接作業ルートに
        executionWorkDir = worktreeTargets[0].worktreeDir;
      } else {
        // 複数リポジトリの場合は各 worktree を内包するチケット用ルートディレクトリ
        executionWorkDir = path.join(this.worktreeManager.getWorktreesDir(), issue.issueKey);
      }

      console.log(`[Dispatcher] エージェント作業ディレクトリ: ${executionWorkDir}`);
      worktreeTargets.forEach((t) => {
        console.log(`  - [${t.repoName}] ${t.worktreeDir} (ブランチ: ${t.branch})`);
      });
    } catch (wtErr: any) {
      const errMsg = `git worktree の準備に失敗しました: ${wtErr.message}`;
      console.error(`[Dispatcher] エラー: ${errMsg}`);
      this.logger?.error("error", errMsg, { issueKey: issue.issueKey, role });
      await this.backlog.addComment(issue.issueKey, `⚠️ **エラー**: ${errMsg}`).catch(() => {});
      return { handled: false };
    }

    let recentComments: string[] = [];
    try {
      if (typeof this.backlog.getComments === "function") {
        const comments = await this.backlog.getComments(issue.issueKey, 5);
        recentComments = comments
          .filter((c) => c.content && c.content.trim().length > 0)
          .map((c) => {
            let text = (c.content || "").trim();
            // 生の NDJSON ログなどノイズ文字列が混入している場合の防御
            if (text.includes('{"event":') || text.includes('"step_update":')) {
              text = "[システムログのため省略]";
            } else if (text.length > 1500) {
              text = text.slice(0, 1500) + "\n...[長文のため一部省略]...";
            }
            return `[${c.createdUser.name}]: ${text}`;
          });
      }
    } catch (e) {
      console.warn(`[Dispatcher] コメント取得スキップ:`, e);
    }

    const isInvestigation = isInvestigationIssue(issue);
    const isFastMode = isFastModeIssue(issue);

    const context: AgentContext = {
      issueKey: issue.issueKey,
      issueSummary: issue.summary,
      issueDescription: issue.description || "",
      recentComments,
      workDir: executionWorkDir,
      isInvestigation,
      isFastMode,
    };

    // 3. エージェント実行
    const startTime = Date.now();
    this.logger?.info("agent_start", `エージェント [${role}] 実行開始 (チケット: ${issue.issueKey})`, {
      issueKey: issue.issueKey,
      role,
      data: {
        executionWorkDir,
        repos: worktreeTargets.map((t) => t.repoName),
      },
    });

    const result = await this.runner.run(role, context);
    const durationMs = Date.now() - startTime;

    const cumulativeTotals = TokenUsageTracker.getTotals();
    this.logger?.info("agent_finish", `エージェント [${role}] 実行完了 (${durationMs}ms)`, {
      issueKey: issue.issueKey,
      role,
      durationMs,
      usage: result.usage ? (result.usage as any) : undefined,
      cumulativeTokens: cumulativeTotals as any,
      data: {
        success: result.success,
        isRejection: result.isRejection,
        summary: result.summary,
        executionWorkDir,
        usage: result.usage,
        cumulativeTokens: cumulativeTotals,
      },
    });

    // 4. 未コミットのドキュメントや修正ファイルが残っている場合、自動でステージング & コミットして保護
    for (const target of worktreeTargets) {
      try {
        const { stdout: statusOut } = await execAsync("git status --porcelain", {
          cwd: target.worktreeDir,
        });
        if (statusOut && statusOut.trim().length > 0) {
          console.log(`[Dispatcher] 未コミットの変更・ドキュメントを検出 (${target.repoName})。自動コミットします...`);
          await execAsync("git add -A", { cwd: target.worktreeDir });
          const commitMsg = isInvestigation
            ? `docs(${role}): record investigation and design artifacts for ${issue.issueKey}`
            : `chore(${role}): auto commit repository artifacts for ${issue.issueKey}`;
          await execAsync(`git commit -m "${commitMsg}"`, { cwd: target.worktreeDir });
        }
      } catch {
        // コミット失敗時（差分なしやコンフリクト等）はスキップ
      }
    }

    // 5. GitHub PR の一括作成 / 取得 (Developer 実装完了時、最終 Requirement-Reviewer フェーズ、Fast モード Code-Reviewer、または調査タスクのフェーズ)
    let prResults: PullRequestResult[] = [];
    const shouldEnsurePr =
      result.success &&
      !result.isRejection &&
      (role === "developer" ||
        role === "requirement-reviewer" ||
        (isFastMode && role === "code-reviewer") ||
        (isInvestigation && (role === "spec-writer" || role === "spec-reviewer")));

    if (shouldEnsurePr) {
      console.log(`[Dispatcher] GitHub プルリクエストを準備中 (${worktreeTargets.length}リポジトリ)...`);
      prResults = await this.githubService.ensurePullRequests(
        worktreeTargets.map((t) => ({ repoName: t.repoName, worktreeDir: t.worktreeDir })),
        {
          issueKey: issue.issueKey,
          summary: issue.summary,
          description: issue.description || "",
          dryRun: this.dryRun,
        }
      );

      if (prResults.length > 0) {
        this.logger?.info("comment_posted", `GitHub PR準備完了 (${prResults.length}件)`, {
          issueKey: issue.issueKey,
          role,
          data: { prs: prResults },
        });
      }
    }

    // 5. 差し戻しカウント制御 & 人間確認（エスカレーション）判定
    const output = result.output || "";
    const hasExplicitHumanRequest = hasHumanEscalationRequest(output);

    let isEscalation = false;
    let escalationReason = "";
    let currentRejectionCount = this.getRejectionCount(issue.issueKey);

    let isQuota = false;
    let resetInfo: { durationSec: number; durationText: string } | null = null;

    if (!result.success) {
      isEscalation = true;
      isQuota =
        /quota|rate\s*limit|429/i.test(output) ||
        /quota|rate\s*limit|429/i.test(result.summary);
      if (isQuota) {
        resetInfo = parseResetDuration(output || result.summary);
        escalationReason = `エージェント [${role}] 実行中にLLMクォータ上限（Quota reached）を検知しました`;
        if (resetInfo) {
          escalationReason += ` (リセット予定: ${resetInfo.durationText}後)`;
        }

        if (this.quotaLockManager) {
          const resetsAt = resetInfo
            ? new Date(Date.now() + resetInfo.durationSec * 1000).toISOString()
            : null;
          this.quotaLockManager.acquire({
            role,
            issueKey: issue.issueKey,
            errorMessage: (output || result.summary).slice(0, 1000).trim(),
            resetsAt,
            resetDurationSec: resetInfo ? resetInfo.durationSec : null,
            resetDurationText: resetInfo?.durationText,
          });
          console.warn(`[Dispatcher] 🔒 クォータロックファイルを作成しました: ${this.quotaLockManager.getLockFilePath()}`);
          this.logger?.warn("quota_locked", `クォータ制限検知: ロックファイル作成 (${this.quotaLockManager.getLockFilePath()})`, {
            issueKey: issue.issueKey,
            role,
            data: { resetsAt, resetInfo },
          });
        }
      } else {
        escalationReason = `エージェント [${role}] が異常終了またはタイムアウトしました (終了コード異常)`;
      }
    } else if (result.isRejection) {
      currentRejectionCount += 1;
      this.rejectionCounts.set(issue.issueKey, currentRejectionCount);
      console.log(`[Dispatcher] 差し戻しを検知: ${issue.issueKey} (累計: ${currentRejectionCount} / 上限: ${this.maxRejectionCount})`);

      if (currentRejectionCount >= this.maxRejectionCount) {
        isEscalation = true;
        escalationReason = `差し戻し上限（${this.maxRejectionCount}回）に達しました（現在: ${currentRejectionCount}回）`;
      }
    } else {
      // 承認または完了時は差し戻しカウンターをリセット
      this.resetRejectionCount(issue.issueKey);
    }

    if (hasExplicitHumanRequest) {
      isEscalation = true;
      escalationReason = escalationReason
        ? `${escalationReason} / エージェントから人間への確認要請がありました`
        : "エージェントから人間への確認要請がありました";
    }

    // 次ステータスおよび件名の決定
    let nextStatusTarget: string;
    let newSummary: string | undefined;
    let nextStatusId: number | null = null;
    const isFinalApproval =
      result.success &&
      !result.isRejection &&
      !isEscalation &&
      (isInvestigation ? role === "spec-reviewer" : (isFastMode ? role === "code-reviewer" : role === "requirement-reviewer"));
    const isCustom = this.isCustomStatusMode(projectStatuses);

    if (isCustom) {
      // 1. カスタム状態モード (上位プラン等)
      if (isEscalation) {
        nextStatusTarget = "確認待ち";
      } else {
        nextStatusTarget = result.success
          ? this.getNextStatusName(role, result.isRejection ?? false, isInvestigation, isFastMode)
          : issue.status.name;
      }
      nextStatusId = this.findStatusIdByName(projectStatuses, nextStatusTarget);
    } else {
      // 2. 件名プレフィックス ＋ 標準ステータスモード (フリープラン等)
      if (isEscalation) {
        const nextPhaseTag = PHASE_TAGS.confirmHuman;
        newSummary = formatSummaryWithPhase(issue.summary, nextPhaseTag);
        nextStatusTarget = `[${nextPhaseTag}]`;
        // 人間に気付かせるため標準ステータス「未対応」へ
        nextStatusId = this.findStatusIdByName(projectStatuses, "未対応") || 1;
      } else {
        const nextPhaseTag = result.success
          ? getNextPhaseTag(role, result.isRejection ?? false, isInvestigation, isFastMode)
          : (parsePhaseFromSummary(issue.summary).tag || getNextPhaseTag(role, false, isInvestigation, isFastMode));
        newSummary = formatSummaryWithPhase(issue.summary, nextPhaseTag);
        nextStatusTarget = `[${nextPhaseTag}]`;
        if (isFinalApproval) {
          // 全工程完了時は人間レビュー待ちのため「処理済み」へ
          nextStatusId = this.findStatusIdByName(projectStatuses, "処理済み") || 3;
        } else {
          // AIリレー中は「処理中」を維持
          nextStatusId = this.findStatusIdByName(projectStatuses, "処理中") || 2;
        }
      }
    }

    // 6. Backlog コメント文面の構築
    const commentLines: string[] = [];

    // PR リンク一覧の整形
    const prSectionLines: string[] = [];
    if (prResults.length === 1) {
      prSectionLines.push(`- 🔗 **GitHub プルリクエスト**: ${prResults[0].prUrl}`);
    } else if (prResults.length > 1) {
      prSectionLines.push(`- 🔗 **GitHub プルリクエスト一覧**:`);
      prResults.forEach((pr) => {
        prSectionLines.push(`  - **${pr.repoName}**: ${pr.prUrl}`);
      });
    }

    if (isEscalation) {
      let resumeRole: AgentRole;
      if (!result.success) {
        // エージェント実行失敗（quota上限やエラー）時は、同じフェーズを再試行するため同一ロールを設定
        resumeRole = role;
      } else if (currentRejectionCount >= this.maxRejectionCount) {
        // 差し戻し上限によるエスカレーション時は修正担当ロールへ戻す
        resumeRole =
          role === "spec-reviewer"
            ? "spec-writer"
            : role === "code-reviewer" || role === "requirement-reviewer"
            ? "developer"
            : role;
      } else {
        // エージェントからの質問・確認要請の場合は同一ロールで回答を受け取る
        resumeRole = role;
      }
      this.lastRoleMap.set(issue.issueKey, resumeRole);
      console.warn(`[Dispatcher] ⚠️ 人間への確認依頼（エスカレーション）を検知: ${escalationReason}`);
      this.logger?.warn("human_escalation", `人間への確認依頼: ${issue.issueKey} (${escalationReason})`, {
        issueKey: issue.issueKey,
        role,
        data: {
          reason: escalationReason,
          rejectionCount: currentRejectionCount,
          maxRejectionCount: this.maxRejectionCount,
          executionWorkDir,
          repos: worktreeTargets.map((t) => t.repoName),
          newSummary,
        },
      });

      const headerTitle = !result.success
        ? (isQuota
            ? `### ⚠️ 【自律パイプライン一時停止】エージェント実行エラー / クォータ上限を検知しました (回復待機モード移行)`
            : `### ⚠️ 【自律パイプライン一時停止】エージェント実行エラー / クォータ上限を検知しました`)
        : `### ⚠️ 【人間への確認依頼】自律パイプラインを一時停止しました`;

      const sectionTitle = !result.success
        ? `#### 実行ログ・エラー詳細:`
        : `#### 🤖 [AI] からの質問・論点要約:`;

      let restartGuide: string;
      if (isQuota) {
        restartGuide = `1. **【自動再開（推奨）】**: デーモンがローカルでクォータ回復待機モードに入りました（Backlogポーリング休止中）。クォータ回復（リセット予定: ${resetInfo?.durationText || "時間経過"}）が確認され次第、本チケットは自動的に再開されます（手動操作は不要です）。\n2. **【手動再開】**: 直ちに再開させたい場合は、クォータロックファイル（\`.aidevflow.quota.lock\`）を削除し、ステータスを **「処理中」** に変更してください。`;
      } else if (!result.success) {
        restartGuide = `1. エラー内容（設定・コード・環境）をご確認ください。\n2. 再開準備が整ったら、ステータスを **「処理中」** に変更してください。\n3. デーモンが検知し、エージェント [${role}] から自動再開します。`;
      } else {
        restartGuide = `1. 本チケットに回答コメント（指示・方針）を投稿してください。\n2. ステータスを **「処理中」**（カスタム状態利用時は「詳細設計中」または「実装中」）に変更してください。\n3. デーモンが回答内容を読み取り、カウンターをリセットして自動再開します。`;
      }

      commentLines.push(
        headerTitle,
        ``,
        `以下の理由により自律処理を停止し、ステータスを **「確認待ち」** に変更しました。`,
        ``,
        `- **理由**: ${escalationReason}`,
        `- **現在のフェーズ**: ${role} (${statusName})`,
        ...(result.isRejection ? [`- **差し戻し回数**: ${currentRejectionCount} / ${this.maxRejectionCount}`] : []),
        `- **対象リポジトリ**: ${worktreeTargets.map((t) => t.repoName).join(", ")}`,
        `- **作業 Worktree**: \`${executionWorkDir}\``,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ...prSectionLines,
        ``,
        sectionTitle,
        result.output,
        ``,
        `---`,
        `#### 👤 人間側の対応手順 (再開方法):`,
        restartGuide
      );
    } else if (isFinalApproval) {
      if (isInvestigation) {
        commentLines.push(
          `### 【調査完了報告】AIエージェントによる調査・設計フェーズが完了しました`,
          ``,
          `チケット **${issue.issueKey}: ${newSummary || issue.summary}** に対する調査・検討・設計工程（spec-writer 調査・仕様策定 → spec-reviewer 調査・仕様レビュー）が完了しました。`,
          ``,
          ...prSectionLines,
          `- **ブランチ**: \`${issue.issueKey}\``,
          `- **作業 Worktree**: \`${executionWorkDir}\``,
          `- **ステータス**: ${nextStatusTarget}`,
          ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
          ``,
          `#### 調査・仕様レビュー報告:`,
          result.output,
          ``,
          `---`,
          `#### 👤 人間レビュー後の対応手順:`,
          `- **【調査結果に問題がない場合】**:`,
          `  1. 調査報告書やリポジトリのドキュメント（docs/ や PR 差分等）をご確認ください。`,
          `  2. リポジトリの変更をマージする場合は、GitHub 上でプルリクエストをマージしてください。`,
          `  3. 本チケットのステータスを **「完了」** に変更してクローズしてください。`,
          `  4. （※コード実装へ進める場合は、本調査・設計結果をもとに新しい実装チケットを作成してください）`,
          `- **【追加調査やドキュメント修正を依頼する場合 (AIに再調査させる)】**:`,
          `  1. 本チケットのコメント欄に追加の論点や指示（「〜についてもドキュメントに追記して」等）を記入してください。`,
          `  2. ステータスを **「処理中」** に変更してください。`,
          `     - デーモンがコメントを検知し、自動的に \`spec-writer\`（調査・仕様策定）が再調査・ドキュメント修正を行います。`
        );
      } else {
        const verificationGuide = this.generateVerificationGuide(
          worktreeTargets,
          executionWorkDir,
          issue.issueKey
        );

        const phaseProcessDesc = isFastMode
          ? "開発工程（実装 → 統合レビュー）"
          : "すべての開発工程（詳細設計 → 設計レビュー → 実装 → 技術レビュー → 要件レビュー）";

        const reviewReportTitle = isFastMode
          ? "#### 統合レビュー報告:"
          : "#### 最終要件レビュー報告:";

        let quotaRemainingText: string | null = null;
        if (typeof this.runner.getQuotaUsage === "function") {
          try {
            const quotaUsage = await this.runner.getQuotaUsage();
            if (quotaUsage?.summaryText) {
              quotaRemainingText = `- **現在のクォータ残量**: ${quotaUsage.summaryText}`;
            }
          } catch {
            // クォータ取得失敗時はスキップ
          }
        }

        commentLines.push(
          `### 【レビュー依頼】AIエージェントによる全工程が完了しました`,
          ``,
          `チケット **${issue.issueKey}: ${newSummary || issue.summary}** に対する${phaseProcessDesc}が完了しました。`,
          ``,
          `以下のプルリクエストをご確認の上、レビュー・マージをお願いいたします。`,
          ``,
          ...prSectionLines,
          `- **ブランチ**: \`${issue.issueKey}\``,
          `- **作業 Worktree**: \`${executionWorkDir}\``,
          `- **ステータス**: ${nextStatusTarget}`,
          ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
          ...(result.usage?.totalTokens
            ? [
                `- **最終フェーズ消費トークン**: 入力: ${result.usage.inputTokens?.toLocaleString()} / 出力: ${result.usage.outputTokens?.toLocaleString()} (思考: ${result.usage.thinkingTokens?.toLocaleString() || 0}) / 合計: ${result.usage.totalTokens?.toLocaleString()} tokens`,
              ]
            : []),
          ...(TokenUsageTracker.getTotals().totalTokens > 0
            ? [
                `- **累計トークン消費 (全セッション計)**: ${TokenUsageTracker.getTotals().totalTokens.toLocaleString()} tokens (${TokenUsageTracker.getTotals().sessionCount}回実行)`,
              ]
            : []),
          ...(quotaRemainingText ? [quotaRemainingText] : []),
          ``,
          reviewReportTitle,
          result.output,
          ``,
          `---`,
          ...verificationGuide,
          ``,
          `---`,
          `#### 👤 人間レビュー後の対応手順:`,
          `- **【要件を満たしており問題ない場合 (完了・マージ)】**:`,
          `  1. GitHub 上でプルリクエストをマージしてください。`,
          `  2. 本チケットのステータスを **「完了」** に変更してください。`,
          `- **【修正や追加要望がある場合 (AIに再修正させる)】**:`,
          `  1. 本チケットのコメント欄に修正指示・指摘を記入してください（PRへのコメント参照でも可）。`,
          `  2. ステータスを **「処理中」** に変更してください。`,
          `     - デーモンがコメントを検知し、自動的に \`developer\`（実装）が修正コミットを作成して PR に追記 push します。`,
          `     - （※設計からの抜本的な見直しを行いたい場合は、件名を \`[詳細設計中]\` に変更してください）`
        );
      }
    } else {
      const guideLines: string[] = [];
      if (prResults.length > 0 && !isInvestigation) {
        guideLines.push(
          ``,
          `---`,
          ...this.generateVerificationGuide(worktreeTargets, executionWorkDir, issue.issueKey)
        );
      }

      const resultLabel = result.success
        ? (result.isRejection ? "差し戻し" : "成功 ([承認])")
        : "失敗 ([エラー])";

      const usageDetail = result.usage?.totalTokens
        ? `**トークン消費量**: 入力: ${result.usage.inputTokens?.toLocaleString()} / 出力: ${result.usage.outputTokens?.toLocaleString()} (思考: ${result.usage.thinkingTokens?.toLocaleString() || 0}) / 合計: ${result.usage.totalTokens?.toLocaleString()} tokens`
        : undefined;

      commentLines.push(
        `### [AI] aidevflow [${role}] 処理報告`,
        `**結果**: ${resultLabel}`,
        `**ブランチ**: \`${issue.issueKey}\``,
        ...prSectionLines,
        `**所要時間**: ${(durationMs / 1000).toFixed(1)}s`,
        ...(usageDetail ? [usageDetail] : []),
        `**次の想定フェーズ**: ${nextStatusTarget}`,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ``,
        `#### 実行ログ・成果物要約:`,
        result.output,
        ...guideLines
      );
    }

    const commentBody = commentLines.filter(Boolean).join("\n");

    if (this.dryRun) {
      console.log(`[DRY_RUN] Backlog更新をスキップしました (次ステータス: ${nextStatusTarget}, statusId: ${nextStatusId}, newSummary: ${newSummary || "なし"})`);
      console.log(`[DRY_RUN] コメント内容:\n`, commentBody);
      return {
        handled: true,
        nextStatusTarget,
        isEscalation,
        rejectionCount: currentRejectionCount,
        newSummary,
        isQuota,
      };
    }

    // 7. Backlog 課題更新 & コメント投稿
    try {
      if (isCustom) {
        if (nextStatusId && nextStatusId !== issue.status.id) {
          console.log(`[Dispatcher] Backlog ステータス更新中: ${issue.status.name} -> ${nextStatusTarget} (id=${nextStatusId})`);
          if (typeof this.backlog.updateIssue === "function") {
            await this.backlog.updateIssue(issue.issueKey, { statusId: nextStatusId, comment: commentBody });
          } else {
            await this.backlog.updateIssueStatus(issue.issueKey, nextStatusId, commentBody);
          }
          console.log(`[Dispatcher] ステータス更新 & コメント投稿完了!`);

          this.logger?.info("status_updated", `ステータス更新: ${issue.status.name} -> ${nextStatusTarget}`, {
            issueKey: issue.issueKey,
            role,
            data: {
              previousStatus: issue.status.name,
              nextStatus: nextStatusTarget,
              nextStatusId,
              prs: prResults,
            },
          });
        } else {
          console.log(`[Dispatcher] 該当するステータスIDが見つからないか同一のため、コメントのみ投稿します。`);
          await this.backlog.addComment(issue.issueKey, commentBody);
          console.log(`[Dispatcher] コメント投稿完了!`);

          this.logger?.info("comment_posted", `コメント投稿完了`, {
            issueKey: issue.issueKey,
            role,
            data: { prs: prResults },
          });
        }
      } else {
        // 件名プレフィックスモード
        console.log(`[Dispatcher] Backlog 更新中 (件名プレフィックスモード): 件名="${newSummary}", ステータスID=${nextStatusId}`);
        if (typeof this.backlog.updateIssue === "function") {
          await this.backlog.updateIssue(issue.issueKey, {
            summary: newSummary,
            statusId: nextStatusId || undefined,
            comment: commentBody,
          });
        } else if (nextStatusId) {
          await this.backlog.updateIssueStatus(issue.issueKey, nextStatusId, commentBody);
        } else {
          await this.backlog.addComment(issue.issueKey, commentBody);
        }
        console.log(`[Dispatcher] 件名・ステータス更新 & コメント投稿完了!`);

        this.logger?.info("status_updated", `件名・ステータス更新: ${issue.summary} -> ${newSummary} (statusId=${nextStatusId})`, {
          issueKey: issue.issueKey,
          role,
          data: {
            previousSummary: issue.summary,
            newSummary,
            previousStatus: issue.status.name,
            nextStatusId,
            prs: prResults,
          },
        });
      }
    } catch (err: any) {
      console.error(`[Dispatcher] Backlog更新エラー:`, err);
      this.logger?.error("error", `Backlog更新失敗: ${err.message}`, {
        issueKey: issue.issueKey,
        role,
      });
      throw err;
    }

    return {
      handled: true,
      nextStatusTarget,
      isEscalation,
      rejectionCount: currentRejectionCount,
      newSummary,
      isQuota,
    };
  }
}
