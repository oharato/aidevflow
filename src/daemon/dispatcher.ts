import path from "path";
import type { BacklogClient } from "../backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../backlog/types.js";
import type { IAgentRunner, AgentRole, AgentContext } from "../agents/types.js";
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
} from "../backlog/prefix-helper.js";

export interface ProcessIssueResult {
  handled: boolean;
  nextStatusTarget?: string;
  isEscalation?: boolean;
  rejectionCount?: number;
  newSummary?: string;
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

  constructor(
    backlog: BacklogClient,
    runner: IAgentRunner,
    defaultRepoPath: string,
    dryRun: boolean = false,
    logger?: JsonlLogger,
    worktreeManager?: GitWorktreeManager,
    githubService?: GitHubService,
    maxRejectionCount: number = 3,
    customStatusModeOverride?: boolean
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
      // 直前のロールがあればそれを再開ロールとし、なければデフォルト "director"
      return this.lastRoleMap.get(issue.issueKey) || "director";
    }

    // [要件レビュー完了] の場合は完了済み
    if (parsed.isCompleted) {
      return null;
    }

    if (parsed.role) {
      return parsed.role;
    }

    // タグがなく「処理中」になっている場合は初期ロール director (詳細設計)
    if (statusName.includes("処理中")) {
      return "director";
    }

    return null;
  }

  resolveRoleFromStatus(statusName: string): AgentRole | null {
    const s = statusName.toLowerCase();

    // 1. 詳細設計 (director)
    if (s.includes("詳細設計") || s.includes("設計中") || s.includes("director")) {
      return "director";
    }

    // 2. 詳細設計レビュー (curator)
    if (s.includes("設計レビュー") || s.includes("curator")) {
      return "curator";
    }

    // 3. 実装 (artist)
    if (s.includes("実装") || s.includes("artist")) {
      return "artist";
    }

    // 4. 技術的観点レビュー (critic)
    if (s.includes("技術レビュー") || s.includes("critic")) {
      return "critic";
    }

    // 5. 要件的観点レビュー (editor)
    if (s.includes("要件レビュー") || s.includes("editor")) {
      return "editor";
    }

    return null;
  }

  getNextStatusName(currentRole: AgentRole, isRejection: boolean): string {
    if (isRejection) {
      switch (currentRole) {
        case "curator":
          return "詳細設計";
        case "critic":
        case "editor":
          return "実装";
        default:
          return "未対応";
      }
    }

    switch (currentRole) {
      case "director":
        return "設計レビュー";
      case "curator":
        return "実装";
      case "artist":
        return "技術レビュー";
      case "critic":
        return "要件レビュー";
      case "editor":
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
        recentComments = comments.map((c) => `[${c.createdUser.name}]: ${c.content}`);
      }
    } catch (e) {
      console.warn(`[Dispatcher] コメント取得スキップ:`, e);
    }

    const context: AgentContext = {
      issueKey: issue.issueKey,
      issueSummary: issue.summary,
      issueDescription: issue.description || "",
      recentComments,
      workDir: executionWorkDir,
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

    this.logger?.info("agent_finish", `エージェント [${role}] 実行完了 (${durationMs}ms)`, {
      issueKey: issue.issueKey,
      role,
      durationMs,
      data: {
        success: result.success,
        isRejection: result.isRejection,
        summary: result.summary,
        executionWorkDir,
      },
    });

    // 4. GitHub PR の一括作成 / 取得 (Artist 実装完了時、または最終 Editor フェーズ)
    let prResults: PullRequestResult[] = [];
    if (result.success && !result.isRejection && (role === "artist" || role === "editor")) {
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
    const hasExplicitHumanRequest =
      output.includes("【人間への確認依頼】") ||
      output.includes("CONFIRM_HUMAN");

    let isEscalation = false;
    let escalationReason = "";
    let currentRejectionCount = this.getRejectionCount(issue.issueKey);

    if (result.isRejection) {
      currentRejectionCount += 1;
      this.rejectionCounts.set(issue.issueKey, currentRejectionCount);
      console.log(`[Dispatcher] 差し戻しを検知: ${issue.issueKey} (累計: ${currentRejectionCount} / 上限: ${this.maxRejectionCount})`);

      if (currentRejectionCount >= this.maxRejectionCount) {
        isEscalation = true;
        escalationReason = `差し戻し上限（${this.maxRejectionCount}回）に達しました（現在: ${currentRejectionCount}回）`;
      }
    } else if (result.success) {
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
    const isFinalApproval = role === "editor" && !result.isRejection && !isEscalation;
    const isCustom = this.isCustomStatusMode(projectStatuses);

    if (isCustom) {
      // 1. カスタム状態モード (上位プラン等)
      if (isEscalation) {
        nextStatusTarget = "確認待ち";
      } else {
        nextStatusTarget = this.getNextStatusName(role, result.isRejection ?? false);
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
        const nextPhaseTag = getNextPhaseTag(role, result.isRejection ?? false);
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
      const resumeRole: AgentRole =
        role === "curator"
          ? "director"
          : role === "critic" || role === "editor"
          ? "artist"
          : role;
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

      commentLines.push(
        `### [注意] 【人間への確認依頼】自律パイプラインを一時停止しました`,
        ``,
        `以下の理由により自律処理を停止し、ステータスを **「確認待ち」** に変更しました。`,
        ``,
        `- **理由**: ${escalationReason}`,
        `- **現在のフェーズ**: ${role} (${statusName})`,
        `- **差し戻し回数**: ${currentRejectionCount} / ${this.maxRejectionCount}`,
        `- **対象リポジトリ**: ${worktreeTargets.map((t) => t.repoName).join(", ")}`,
        `- **作業 Worktree**: \`${executionWorkDir}\``,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ...prSectionLines,
        ``,
        `#### [AI] からの質問・論点要約:`,
        result.output,
        ``,
        `---`,
        `#### [手順] 人間側の対応手順 (再開方法):`,
        `1. 本チケットに回答コメント（指示・方針）を投稿してください。`,
        `2. ステータスを **「処理中」**（カスタム状態利用時は「詳細設計中」または「実装中」）に変更してください。`,
        `3. デーモンが回答内容を読み取り、カウンターをリセットして自動再開します。`
      );
    } else if (isFinalApproval) {
      commentLines.push(
        `### 【レビュー依頼】AIエージェントによる全工程が完了しました`,
        ``,
        `チケット **${issue.issueKey}: ${newSummary || issue.summary}** に対するすべての開発工程（詳細設計 → 設計レビュー → 実装 → 技術レビュー → 要件レビュー）が完了しました。`,
        ``,
        `以下のプルリクエストをご確認の上、レビュー・マージをお願いいたします。`,
        ``,
        ...prSectionLines,
        `- **ブランチ**: \`${issue.issueKey}\``,
        `- **作業 Worktree**: \`${executionWorkDir}\``,
        `- **ステータス**: ${nextStatusTarget}`,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ``,
        `#### 最終要件レビュー報告:`,
        result.output
      );
    } else {
      commentLines.push(
        `### [AI] aidevflow [${role}] 処理報告`,
        `**結果**: ${result.success ? "成功" : "失敗"} (${result.isRejection ? "[差し戻し]" : "[完了/承認]"})`,
        `**ブランチ**: \`${issue.issueKey}\``,
        ...prSectionLines,
        `**所要時間**: ${(durationMs / 1000).toFixed(1)}s`,
        `**次の想定フェーズ**: ${nextStatusTarget}`,
        ...(newSummary ? [`- **新件名**: \`${newSummary}\``] : []),
        ``,
        `#### 実行ログ・成果物要約:`,
        result.output
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
    };
  }
}
