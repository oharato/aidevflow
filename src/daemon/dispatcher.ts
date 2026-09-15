import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import type { IIssueTracker, TrackedIssue, IssueLifecycleState } from "../tracker/types.js";
import { wrapLegacyIssueClient } from "../tracker/factory.js";
import type { IAgentRunner, AgentRole, AgentContext } from "../agents/types.js";
import { TokenUsageTracker } from "../agents/runner.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import { extractRepositoryPaths } from "../git/repo-parser.js";
import { GitWorktreeManager, type WorktreeTarget } from "../git/worktree.js";
import { GitHubService, type PullRequestResult } from "../git/github.js";
import { QuotaLockManager, parseResetDuration } from "./quota-lock.js";
import { loadWorkflow } from "../workflow/loader.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { PermissionGuard, type GitSnapshot } from "../workflow/permission.js";
import { parseDecision } from "../workflow/decision.js";
import type { WorkflowStep } from "../workflow/types.js";
import {
  PHASE_TAGS,
  formatSummaryWithPhase,
  parsePhaseFromSummary,
  isInvestigationIssue,
  isFastModeIssue,
  stripPhasePrefix,
  getNextPhaseTag,
  hasCustomStatuses,
} from "../tracker/prefix-helper.js";

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

/**
 * 任意のチケットオブジェクトを BTS 共通の TrackedIssue に透過変換するヘルパー (後方互換性対応)
 */
export function ensureTrackedIssue(issue: TrackedIssue | object | unknown): TrackedIssue {
  if (issue && typeof issue === "object" && "key" in issue && "lifecycleState" in issue) {
    return issue as TrackedIssue;
  }
  const obj = (issue && typeof issue === "object" ? issue : {}) as Record<string, unknown>;
  const key = (typeof obj.key === "string" ? obj.key : undefined) || (typeof obj.issueKey === "string" ? obj.issueKey : undefined) || "ISSUE-1";
  const rawTitle = (typeof obj.rawTitle === "string" ? obj.rawTitle : undefined) || (typeof obj.summary === "string" ? obj.summary : "") || "";
  const title = stripPhasePrefix(rawTitle);
  const statusObj = obj.status as { name?: string } | undefined;
  const rawStatusName = (typeof obj.rawStatusName === "string" ? obj.rawStatusName : undefined) || statusObj?.name || "未対応";
  const description = typeof obj.description === "string" ? obj.description : "";
  const recentComments = Array.isArray(obj.recentComments)
    ? (obj.recentComments as string[])
    : [];

  const issueTypeObj = obj.issueType as { name?: string } | undefined;
  const isInvestigation =
    typeof obj.isInvestigation === "boolean"
      ? obj.isInvestigation
      : (/\[(?:調査|検討|設計|research|investigation)\]/i.test(rawTitle) ||
          issueTypeObj?.name === "調査");
  const isFastMode =
    typeof obj.isFastMode === "boolean"
      ? obj.isFastMode
      : (/\[fast\]/i.test(rawTitle) || /mode:\s*fast/i.test(description));

  return {
    key,
    id: (typeof obj.id === "number" || typeof obj.id === "string") ? obj.id : undefined,
    title,
    rawTitle,
    description,
    currentStepName: typeof obj.currentStepName === "string" ? obj.currentStepName : undefined,
    currentStepDef: obj.currentStepDef as WorkflowStep | undefined,
    lifecycleState: (obj.lifecycleState as IssueLifecycleState) || "in_progress",
    rawStatusName,
    recentComments,
    isInvestigation,
    isFastMode,
    updatedAt: (typeof obj.updatedAt === "string" ? obj.updatedAt : undefined) || (typeof obj.updated === "string" ? obj.updated : undefined) || new Date().toISOString(),
  };
}

export class AgentDispatcher {
  private tracker?: IIssueTracker;
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
  private requireHumanSpecApproval: boolean = false;
  private permissionGuard: PermissionGuard;

  constructor(
    trackerOrClient: IIssueTracker | object,
    runner: IAgentRunner,
    defaultRepoPath: string,
    dryRun: boolean = false,
    logger?: JsonlLogger,
    worktreeManager?: GitWorktreeManager,
    githubService?: GitHubService,
    maxRejectionCount: number = 3,
    customStatusModeOverride?: boolean,
    quotaLockManager?: QuotaLockManager,
    requireHumanSpecApproval: boolean = false,
    permissionGuard?: PermissionGuard
  ) {
    this.tracker = wrapLegacyIssueClient(trackerOrClient, customStatusModeOverride);
    this.runner = runner;
    this.defaultRepoPath = defaultRepoPath;
    this.dryRun = dryRun;
    this.logger = logger;
    this.worktreeManager = worktreeManager || new GitWorktreeManager();
    this.githubService = githubService || new GitHubService();
    this.maxRejectionCount = maxRejectionCount;
    this.customStatusModeOverride = customStatusModeOverride;
    this.quotaLockManager = quotaLockManager;
    this.requireHumanSpecApproval = requireHumanSpecApproval;
    this.permissionGuard = permissionGuard || new PermissionGuard();
  }

  getTracker(): IIssueTracker | undefined {
    return this.tracker;
  }

  setTracker(tracker: IIssueTracker): void {
    this.tracker = tracker;
  }

  getPermissionGuard(): PermissionGuard {
    return this.permissionGuard;
  }

  setPermissionGuard(guard: PermissionGuard): void {
    this.permissionGuard = guard;
  }

  setRequireHumanSpecApproval(enabled: boolean): void {
    this.requireHumanSpecApproval = enabled;
  }

  getRequireHumanSpecApproval(): boolean {
    return this.requireHumanSpecApproval;
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

  isCustomStatusMode(statuses?: Array<{ name: string }> | unknown[]): boolean {
    if (this.customStatusModeOverride !== undefined) {
      return this.customStatusModeOverride;
    }
    if (this.tracker?.isCustomStatusMode && this.tracker.isCustomStatusMode()) {
      return true;
    }
    if (Array.isArray(statuses) && statuses.length > 0) {
      const first = statuses[0];
      if (first && typeof first === "object" && "name" in first && typeof (first as { name: unknown }).name === "string") {
        return hasCustomStatuses(statuses as Array<{ name: string }>);
      }
    }
    return false;
  }

  getRejectionCount(issueKey: string): number {
    return this.rejectionCounts.get(issueKey) || 0;
  }

  resetRejectionCount(issueKey: string): void {
    this.rejectionCounts.delete(issueKey);
  }

  resolveRole(
    issueInput: TrackedIssue | object,
    statuses?: Array<{ name: string }> | unknown[]
  ): AgentRole | string | null {
    const issue = ensureTrackedIssue(issueInput);
    if (this.isCustomStatusMode(statuses)) {
      if (issue.currentStepName) {
        return issue.currentStepDef?.role || issue.currentStepName;
      }
      return this.resolveRoleFromStatus(issue.rawStatusName);
    }
    return this.resolveRoleFromSummary(issue);
  }

  resolveRoleFromSummary(issueInput: TrackedIssue | object | unknown): AgentRole | null {
    const tracked = ensureTrackedIssue(issueInput);
    const statusName = tracked.rawStatusName;
    const summary = tracked.rawTitle || tracked.title;
    // プレフィックスモードでは「処理中」または「未対応」を対象とする
    if (!statusName.includes("処理中") && !statusName.includes("未対応")) {
      return null;
    }

    const parsed = parsePhaseFromSummary(summary);

    // [設計承認待ち] タグが付いている場合:
    if (parsed.tag === PHASE_TAGS.specApprovalWait) {
      // 人間承認待ちの間（未対応）はスキップ
      if (statusName.includes("未対応")) {
        return null;
      }
      // 人間が設計を承認してステータスを「処理中」に変更した場合は developer (実装) を開始
      if (statusName.includes("処理中")) {
        return "developer";
      }
      return null;
    }

    // [確認待ち] タグが付いている場合:
    if (parsed.isWaitingConfirmation) {
      // 人間確認待ちの間（未対応）はスキップ
      if (statusName.includes("未対応")) {
        return null;
      }
      // 人間が回答してステータスを「処理中」に変更した場合は再開
      // 直前のロールがあればそれを再開ロールとし、なければデフォルト "spec-writer"
      return this.lastRoleMap.get(tracked.key) || "spec-writer";
    }

    // [要件レビュー完了] または [調査完了] の場合:
    if (parsed.isCompleted) {
      // 人間がレビュー後に差し戻してステータスを「処理中」に変更した場合:
      // 調査タスクなら再調査・設計修正 (spec-writer)、実装タスクなら実装修正 (developer) を再開
      if (statusName.includes("処理中")) {
        return tracked.isInvestigation ? "spec-writer" : "developer";
      }
      return null;
    }

    if (parsed.role) {
      return parsed.role;
    }

    // タグがなく「処理中」になっている場合:
    // Fastモードなら初期ロールは developer (実装)、それ以外は spec-writer (詳細仕様策定)
    if (statusName.includes("処理中")) {
      return tracked.isFastMode ? "developer" : "spec-writer";
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
        return isInvestigation
          ? "完了"
          : (this.requireHumanSpecApproval ? "確認待ち" : "実装");
      case "developer":
        return "技術レビュー";
      case "code-reviewer":
        return isFastMode ? "完了" : "要件レビュー";
      case "requirement-reviewer":
        return "完了";
    }
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

  async processIssue(
    issueInput: TrackedIssue | object,
    statuses?: Array<{ name: string }> | unknown[]
  ): Promise<ProcessIssueResult> {
    if (this.tracker?.setProjectStatuses && Array.isArray(statuses) && statuses.length > 0) {
      this.tracker.setProjectStatuses(statuses);
    }
    const issue = ensureTrackedIssue(issueInput);
    const issueKey = issue.key;
    const issueSummary = issue.rawTitle || issue.title;
    const issueDescription = issue.description || "";
    const statusName = issue.rawStatusName;

    const role = this.resolveRole(issue, statuses);

    if (!role) {
      return { handled: false };
    }

    console.log(`\n----------------------------------------`);
    console.log(`[Dispatcher] 課題検知: ${issueKey} [${issueSummary}]`);
    console.log(`[Dispatcher] 現在のステータス: "${statusName}" -> 担当エージェント: [${role}]`);
    console.log(`----------------------------------------`);

    this.logger?.info("issue_detected", `課題検知: ${issueKey} (${statusName})`, {
      issueKey,
      role,
      data: { summary: issueSummary, status: statusName },
    });

    // 1. チケット詳細から1つまたは複数のリポジトリパス/URLを抽出
    const rawRepoPaths = extractRepositoryPaths(issueDescription, this.defaultRepoPath);
    if (rawRepoPaths.length === 0) {
      const errMsg = `リポジトリ情報をチケット詳細から検出できず、フォールバック設定もありません。詳細に「リポジトリ: <URLまたはパス>」を記載してください。`;
      console.error(`[Dispatcher] エラー: ${errMsg}`);
      this.logger?.error("error", errMsg, { issueKey, role });
      if (this.tracker) {
        await this.tracker.addComment(issueKey, `⚠️ **エラー**: ${errMsg}`).catch(() => {});
      }
      return { handled: false };
    }

    console.log(`[Dispatcher] 対象リポジトリ (${rawRepoPaths.length}件):`, rawRepoPaths);

    // 2. git worktree を準備 (~/aidevflow/worktrees/<issueKey>/<repoName>)
    let worktreeTargets: WorktreeTarget[] = [];
    let executionWorkDir = "";

    try {
      worktreeTargets = await this.worktreeManager.ensureWorktrees(rawRepoPaths, issueKey);

      if (worktreeTargets.length === 1) {
        // 単一リポジトリの場合はその worktree ディレクトリを直接作業ルートに
        executionWorkDir = worktreeTargets[0].worktreeDir;
      } else {
        // 複数リポジトリの場合は各 worktree を内包するチケット用ルートディレクトリ
        executionWorkDir = path.join(this.worktreeManager.getWorktreesDir(), issueKey);
      }

      console.log(`[Dispatcher] エージェント作業ディレクトリ: ${executionWorkDir}`);
      worktreeTargets.forEach((t) => {
        console.log(`  - [${t.repoName}] ${t.worktreeDir} (ブランチ: ${t.branch})`);
      });
    } catch (wtErr: unknown) {
      const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
      const errMsg = `git worktree の準備に失敗しました: ${msg}`;
      console.error(`[Dispatcher] エラー: ${errMsg}`);
      this.logger?.error("error", errMsg, { issueKey, role });
      if (this.tracker) {
        await this.tracker.addComment(issueKey, `⚠️ **エラー**: ${errMsg}`).catch(() => {});
      }
      return { handled: false };
    }

    let recentComments: string[] = [];
    try {
      if (issue.recentComments && issue.recentComments.length > 0) {
        recentComments = issue.recentComments;
      } else if (this.tracker?.getRecentComments) {
        recentComments = await this.tracker.getRecentComments(issueKey, 5);
      }
    } catch (e: unknown) {
      console.warn(`[Dispatcher] コメント取得スキップ:`, e);
    }

    const isInvestigation = issue.isInvestigation;
    const isFastMode = issue.isFastMode;

    // ワークフロー定義の解決とステップ情報の取得
    const projectKey = issueKey.split("-")[0];
    const workflowDef = loadWorkflow({
      isFastMode,
      isInvestigation,
      projectKey,
    });
    const currentStep =
      workflowDef.steps[role] ||
      Object.values(workflowDef.steps).find((s) => s.role === role);
    const editAllowed = currentStep ? currentStep.edit : (role === "spec-writer" || role === "developer");

    const context: AgentContext = {
      issueKey,
      issueSummary,
      issueDescription,
      recentComments,
      workDir: executionWorkDir,
      isInvestigation,
      isFastMode,
      readOnly: !editAllowed,
      trackerType: this.tracker?.trackerType,
    };

    // 権限制御 (edit: false) の場合、実行前の Git 状態スナップショットを記録
    const gitSnapshots: GitSnapshot[] = [];
    if (!editAllowed) {
      for (const target of worktreeTargets) {
        const snap = await this.permissionGuard.snapshot(target.worktreeDir);
        gitSnapshots.push(snap);
      }
    }

    // 3. エージェント実行
    const startTime = Date.now();
    this.logger?.info("agent_start", `エージェント [${role}] 実行開始 (チケット: ${issueKey})`, {
      issueKey,
      role,
      data: {
        executionWorkDir,
        repos: worktreeTargets.map((t) => t.repoName),
      },
    });

    const result = await this.runner.run(role as AgentRole, context);
    const durationMs = Date.now() - startTime;

    // 権限制御 (edit: false) の場合、実行後の状態を検証し不正変更があれば即時ロールバック
    const rollbackReasons: string[] = [];
    if (!editAllowed) {
      for (const snap of gitSnapshots) {
        const rbResult = await this.permissionGuard.verifyAndRollback(snap);
        if (rbResult.rolledBack) {
          rollbackReasons.push(...rbResult.reasons);
        }
      }
      if (rollbackReasons.length > 0) {
        console.warn(`[Dispatcher] ⚠️ レビュアーによる不正変更を検知・ロールバックしました:`, rollbackReasons);
      }
    }

    const cumulativeTotals = TokenUsageTracker.getTotals();
    this.logger?.info("agent_finish", `エージェント [${role}] 実行完了 (${durationMs}ms)`, {
      issueKey,
      role,
      durationMs,
      usage: result.usage,
      cumulativeTokens: cumulativeTotals,
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
    // (edit: true なステップのみ実行。レビュアー役の不正変更は PermissionGuard で既に破棄済み)
    if (editAllowed) {
      for (const target of worktreeTargets) {
        try {
          const { stdout: statusOut } = await execAsync("git status --porcelain", {
            cwd: target.worktreeDir,
          });
          if (statusOut && statusOut.trim().length > 0) {
            console.log(`[Dispatcher] 未コミットの変更・ドキュメントを検出 (${target.repoName})。自動コミットします...`);
            await execAsync("git add -A", { cwd: target.worktreeDir });
            const commitMsg = isInvestigation
              ? `docs(${role}): record investigation and design artifacts for ${issueKey}`
              : `chore(${role}): auto commit repository artifacts for ${issueKey}`;
            await execAsync(`git commit -m "${commitMsg}"`, { cwd: target.worktreeDir });
          }
        } catch {
          // コミット失敗時（差分なしやコンフリクト等）はスキップ
        }
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
          issueKey,
          summary: issueSummary,
          description: issueDescription,
          dryRun: this.dryRun,
        }
      );

      if (prResults.length > 0) {
        this.logger?.info("comment_posted", `GitHub PR準備完了 (${prResults.length}件)`, {
          issueKey,
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
    let currentRejectionCount = this.getRejectionCount(issueKey);

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
            role: role as AgentRole,
            issueKey,
            errorMessage: (output || result.summary).slice(0, 1000).trim(),
            resetsAt,
            resetDurationSec: resetInfo ? resetInfo.durationSec : null,
            resetDurationText: resetInfo?.durationText,
          });
          console.warn(`[Dispatcher] 🔒 クォータロックファイルを作成しました: ${this.quotaLockManager.getLockFilePath()}`);
          this.logger?.warn("quota_locked", `クォータ制限検知: ロックファイル作成 (${this.quotaLockManager.getLockFilePath()})`, {
            issueKey,
            role,
            data: { resetsAt, resetInfo },
          });
        }
      } else {
        escalationReason = `エージェント [${role}] が異常終了またはタイムアウトしました (終了コード異常)`;
      }
    } else if (result.isRejection) {
      currentRejectionCount += 1;
      this.rejectionCounts.set(issueKey, currentRejectionCount);
      console.log(`[Dispatcher] 差し戻しを検知: ${issueKey} (累計: ${currentRejectionCount} / 上限: ${this.maxRejectionCount})`);

      if (currentRejectionCount >= this.maxRejectionCount) {
        isEscalation = true;
        escalationReason = `差し戻し上限（${this.maxRejectionCount}回）に達しました（現在: ${currentRejectionCount}回）`;
      }
    } else {
      // 承認または完了時は差し戻しカウンターをリセット
      this.resetRejectionCount(issueKey);
    }

    if (hasExplicitHumanRequest) {
      isEscalation = true;
      escalationReason = escalationReason
        ? `${escalationReason} / エージェントから人間への確認要請がありました`
        : "エージェントから人間への確認要請がありました";
    }

    const isSpecApprovalWait =
      result.success &&
      !result.isRejection &&
      !isEscalation &&
      !isInvestigation &&
      role === "spec-reviewer" &&
      this.requireHumanSpecApproval;

    const isFinalApproval =
      result.success &&
      !result.isRejection &&
      !isEscalation &&
      (isInvestigation ? role === "spec-reviewer" : (isFastMode ? role === "code-reviewer" : role === "requirement-reviewer"));
    const isCustom = this.isCustomStatusMode(statuses);

    // 次ステータスおよび表示名の決定
    let nextStatusTarget: string;
    let nextStepDef: WorkflowStep | null = null;
    let newSummary: string | undefined = undefined;

    if (isCustom) {
      if (isEscalation) {
        nextStatusTarget = "確認待ち";
      } else if (isSpecApprovalWait) {
        nextStatusTarget = "設計承認待ち";
      } else if (isFinalApproval) {
        nextStatusTarget = "完了";
      } else {
        const nextStatusOrRole = this.getNextStatusName(role as AgentRole, result.isRejection ?? false, isInvestigation, isFastMode);
        const nextRole = this.resolveRoleFromStatus(nextStatusOrRole) || nextStatusOrRole;
        nextStepDef =
          workflowDef.steps[nextRole] ||
          Object.values(workflowDef.steps).find(
            (s: WorkflowStep) => s.role === nextRole || s.name === nextRole || s.custom_status === nextStatusOrRole
          ) || null;
        nextStatusTarget = nextStepDef?.custom_status || (nextStepDef ? `[${nextStepDef.name}]` : nextStatusOrRole);
      }
    } else {
      // プレフィックスモード
      if (isEscalation) {
        const nextPhaseTag = PHASE_TAGS.confirmHuman;
        newSummary = formatSummaryWithPhase(issueSummary, nextPhaseTag);
        nextStatusTarget = `[${nextPhaseTag}]`;
      } else {
        const nextPhaseTag = result.success
          ? getNextPhaseTag(role as AgentRole, result.isRejection ?? false, isInvestigation, isFastMode, this.requireHumanSpecApproval)
          : (parsePhaseFromSummary(issueSummary).tag || getNextPhaseTag(role as AgentRole, false, isInvestigation, isFastMode, this.requireHumanSpecApproval));
        newSummary = formatSummaryWithPhase(issueSummary, nextPhaseTag);
        nextStatusTarget = `[${nextPhaseTag}]`;

        if (!isFinalApproval && !isSpecApprovalWait) {
          const nextStatusOrRole = this.getNextStatusName(role as AgentRole, result.isRejection ?? false, isInvestigation, isFastMode);
          const nextRole = this.resolveRoleFromStatus(nextStatusOrRole) || nextStatusOrRole;
          nextStepDef =
            workflowDef.steps[nextRole] ||
            Object.values(workflowDef.steps).find(
              (s: WorkflowStep) => s.role === nextRole || s.name === nextRole || s.custom_status === nextStatusOrRole
            ) || null;
        }
      }
    }

    // 6. チケットコメント文面の構築
    const commentLines: string[] = [];

    // 権限制御によるロールバックが発生した場合、コメント冒頭に注意喚起を明記
    if (rollbackReasons.length > 0) {
      commentLines.push(
        `> ⚠️ **【権限制御 (PermissionGuard)】**: 読み取り専用ステップ中に不正なファイル変更を検知したため、安全にロールバック・破棄しました。`
      );
      rollbackReasons.forEach((r) => commentLines.push(`> - ${r}`));
      commentLines.push(``);
    }

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
        resumeRole = role as AgentRole;
      } else if (currentRejectionCount >= this.maxRejectionCount) {
        // 差し戻し上限によるエスカレーション時は修正担当ロールへ戻す
        resumeRole =
          role === "spec-reviewer"
            ? "spec-writer"
            : role === "code-reviewer" || role === "requirement-reviewer"
            ? "developer"
            : (role as AgentRole);
      } else {
        // エージェントからの質問・確認要請の場合は同一ロールで回答を受け取る
        resumeRole = role as AgentRole;
      }
      this.lastRoleMap.set(issueKey, resumeRole);
      console.warn(`[Dispatcher] ⚠️ 人間への確認依頼（エスカレーション）を検知: ${escalationReason}`);
      this.logger?.warn("human_escalation", `人間への確認依頼: ${issueKey} (${escalationReason})`, {
        issueKey,
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
        restartGuide = `1. **【自動再開（推奨）】**: デーモンがローカルでクォータ回復待機モードに入りました（BTSポーリング休止中）。クォータ回復（リセット予定: ${resetInfo?.durationText || "時間経過"}）が確認され次第、本チケットは自動的に再開されます（手動操作は不要です）。\n2. **【手動再開】**: 直ちに再開させたい場合は、クォータロックファイル（\`.aidevflow.quota.lock\`）を削除し、ステータスを **「処理中」** に変更してください。`;
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
    } else if (isSpecApprovalWait) {
      const usageDetail = result.usage?.totalTokens
        ? `**トークン消費量**: 入力: ${result.usage.inputTokens?.toLocaleString()} / 出力: ${result.usage.outputTokens?.toLocaleString()} (思考: ${result.usage.thinkingTokens?.toLocaleString() || 0}) / 合計: ${result.usage.totalTokens?.toLocaleString()} tokens`
        : undefined;

      commentLines.push(
        `### ⏸️ 【設計承認のお願い】AIによる詳細設計および設計レビューが完了しました`,
        ``,
        `チケット **${issueKey}: ${newSummary || issueSummary}** に対する詳細設計（spec-writer）および設計レビュー（spec-reviewer）が承認（LGTM）されました。`,
        ``,
        `実装フェーズ（developer）へ進む前に、設計内容のご確認とご承認をお願いいたします。`,
        ``,
        ...prSectionLines,
        `- **ブランチ**: \`${issueKey}\``,
        `- **作業 Worktree**: \`${executionWorkDir}\``,
        `- **ステータス**: ${nextStatusTarget}`,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ...(usageDetail ? [usageDetail] : []),
        ``,
        `#### 調査・設計レビュー報告:`,
        result.output,
        ``,
        `---`,
        `#### 👤 人間側の対応手順 (再開方法):`,
        `- **【設計に問題がない場合 (実装開始)】**:`,
        `  1. リポジトリ内の詳細設計書（\`docs/detailed_design.md\` や PR 差分等）をご確認ください。`,
        `  2. 本チケットのステータスを **「処理中」** に変更してください。`,
        `     - デーモンが検知し、自動的に \`developer\` が実装を開始します。`,
        `- **【修正や方針変更を指示する場合 (AIに再設計させる)】**:`,
        `  1. 本チケットのコメント欄に修正指示やフィードバックを記入してください。`,
        `  2. ステータスを **「処理中」** に変更してください。`,
        `     - デーモンがコメントを検知し、\`spec-writer\` が設計書の修正を行います。`
      );
    } else if (isFinalApproval) {
      if (isInvestigation) {
        const prListDesc = prResults.length > 0
          ? [
              ...prSectionLines,
              `- **ブランチ**: \`${issueKey}\``,
              `- **作業 Worktree**: \`${executionWorkDir}\``,
            ]
          : [];

        commentLines.push(
          `### 【調査完了報告】AIエージェントによる調査・設計フェーズが完了しました`,
          ``,
          `チケット **${issueKey}: ${newSummary || issueSummary}** に対する調査・検討・設計工程（spec-writer 調査・仕様策定 → spec-reviewer 調査・仕様レビュー）が完了しました。`,
          ``,
          ...prListDesc,
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
          ``,
          `#### 調査結果・仕様書要約:`,
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
          issueKey
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
          `チケット **${issueKey}: ${newSummary || issueSummary}** に対する${phaseProcessDesc}が完了しました。`,
          ``,
          `以下のプルリクエストをご確認の上、レビュー・マージをお願いいたします。`,
          ``,
          ...prSectionLines,
          `- **ブランチ**: \`${issueKey}\``,
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
          ...this.generateVerificationGuide(worktreeTargets, executionWorkDir, issueKey)
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
        `**ブランチ**: \`${issueKey}\``,
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
      console.log(`[DRY_RUN] BTS更新をスキップしました (次ステータス: ${nextStatusTarget}, newSummary: ${newSummary || "なし"})`);
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

    // 7. BTS 課題更新 & コメント投稿
    try {
      if (this.tracker) {
        if (isEscalation) {
          await this.tracker.updateLifecycle(issueKey, "waiting_confirmation", {
            reason: escalationReason,
            comment: commentBody,
            newSummary,
          });
        } else if (isSpecApprovalWait) {
          await this.tracker.updateLifecycle(issueKey, "waiting_approval", {
            comment: commentBody,
            newSummary,
          });
        } else if (isFinalApproval) {
          await this.tracker.updateLifecycle(issueKey, "completed", {
            comment: commentBody,
            newSummary,
          });
        } else {
          const nextStatusOrRole = this.getNextStatusName(role as AgentRole, result.isRejection ?? false, isInvestigation, isFastMode);
          const nextRole = this.resolveRoleFromStatus(nextStatusOrRole) || nextStatusOrRole;
          const nextStepDef =
            workflowDef.steps[nextRole] ||
            Object.values(workflowDef.steps).find(
              (s) => s.role === nextRole || s.name === nextRole || s.custom_status === nextStatusOrRole
            );

          if (nextStepDef) {
            await this.tracker.updateIssueStep(issueKey, nextStepDef, {
              comment: commentBody,
              newSummary,
            });
          } else {
            await this.tracker.addComment(issueKey, commentBody);
          }
        }
        console.log(`[Dispatcher] IIssueTracker 経由のステータス更新 & コメント投稿完了!`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Dispatcher] 課題更新エラー:`, err);
      this.logger?.error("error", `課題更新失敗: ${errMsg}`, {
        issueKey,
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
