import type { BacklogClient } from "../backlog/client.js";
import type { AgentDispatcher } from "./dispatcher.js";
import type { BacklogStatus, BacklogIssue } from "../backlog/types.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import { QuotaLockManager, type QuotaLockMetadata } from "./quota-lock.js";
import type { QuotaProbeResult, AgentRole } from "../agents/types.js";
import { TokenUsageTracker } from "../agents/runner.js";
import { PHASE_TAGS, formatSummaryWithPhase } from "../backlog/prefix-helper.js";

export interface PollerFilterOptions {
  targetIssueType?: string;
  targetCategory?: string;
  requireAiTag?: boolean;
}

export class BacklogPoller {
  private backlog: BacklogClient;
  private dispatcher: AgentDispatcher;
  private projectKey: string;
  private targetIssueKey?: string;
  private intervalMs: number;
  private maxConcurrency: number;
  private isRunning: boolean = false;
  private isPolling: boolean = false;
  private inFlightIssues: Set<string> = new Set();
  private activeTasks: Map<string, Promise<void>> = new Map();
  private projectId: number | null = null;
  private projectStatuses: BacklogStatus[] = [];
  private issueStatusCache: Map<string, string> = new Map();
  private logger?: JsonlLogger;
  private filterOptions?: PollerFilterOptions;
  private quotaLockManager: QuotaLockManager;
  private quotaProbeIntervalSec: number;
  private quotaAutoResume: boolean;
  private lastQuotaLogAt: number = 0;

  constructor(
    backlog: BacklogClient,
    dispatcher: AgentDispatcher,
    projectKey: string,
    targetIssueKey?: string,
    intervalSec: number = 10,
    logger?: JsonlLogger,
    filterOptions?: PollerFilterOptions,
    maxConcurrency: number = 2,
    quotaLockManager?: QuotaLockManager,
    quotaProbeIntervalSec: number = 300,
    quotaAutoResume: boolean = true
  ) {
    this.backlog = backlog;
    this.dispatcher = dispatcher;
    this.projectKey = projectKey;
    this.targetIssueKey = targetIssueKey;
    this.intervalMs = intervalSec * 1000;
    this.logger = logger;
    this.filterOptions = filterOptions;
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.quotaLockManager =
      quotaLockManager || dispatcher.getQuotaLockManager() || new QuotaLockManager();
    this.quotaProbeIntervalSec = quotaProbeIntervalSec;
    this.quotaAutoResume = quotaAutoResume;
  }

  getQuotaLockManager(): QuotaLockManager {
    return this.quotaLockManager;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  getInFlightIssues(): string[] {
    return Array.from(this.inFlightIssues);
  }

  getActiveCount(): number {
    return this.inFlightIssues.size;
  }

  async waitForActiveTasks(): Promise<void> {
    if (this.activeTasks.size === 0) return;
    await Promise.allSettled(Array.from(this.activeTasks.values()));
  }

  async init(): Promise<void> {
    const project = await this.backlog.getProject(this.projectKey);
    this.projectId = project.id;
    console.log(`[Poller] プロジェクト取得成功: "${project.name}" (ID: ${project.id})`);

    this.projectStatuses = await this.backlog.getProjectStatuses(project.id);
    console.log(`[Poller] 登録ステータス一覧:`);
    this.projectStatuses.forEach((st) => {
      console.log(`  - [ID: ${st.id}] "${st.name}" (色: ${st.color})`);
    });

    const isCustom = this.dispatcher.isCustomStatusMode(this.projectStatuses);
    if (isCustom) {
      console.log(`[Poller] 動作モード: 【カスタム状態モード】（詳細設計中 / 実装中 等を使用）`);
    } else {
      console.log(`[Poller] 動作モード: 【件名プレフィックスモード】（標準4状態 ＋ [詳細設計中] 等の件名タグを使用）`);
    }

    console.log(`[Poller] 最大同時並行チケット数: ${this.maxConcurrency}`);

    if (this.filterOptions?.targetIssueType) {
      console.log(`[Poller] フィルタ: 種別="${this.filterOptions.targetIssueType}" のみ対象`);
    }
    if (this.filterOptions?.targetCategory) {
      console.log(`[Poller] フィルタ: カテゴリー="${this.filterOptions.targetCategory}" のみ対象`);
    }
    if (this.filterOptions?.requireAiTag) {
      console.log(`[Poller] フィルタ: 件名 [AI] タグ必須`);
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log(`[Poller] デーモンを開始しました。プロジェクト: "${this.projectKey}", ポーリング間隔: ${this.intervalMs / 1000}s, 並行数: ${this.maxConcurrency}`);
    if (this.targetIssueKey) {
      console.log(`[Poller] (特定チケット限定モード: ${this.targetIssueKey})`);
    }

    this.logger?.info("daemon_start", `デーモン起動: プロジェクト "${this.projectKey}"`, {
      data: { projectKey: this.projectKey, targetIssueKey: this.targetIssueKey, maxConcurrency: this.maxConcurrency },
    });

    try {
      await this.init();
    } catch (err: any) {
      console.error(`[Poller] 初期化エラー (プロジェクトまたはステータス取得失敗):`, err);
      this.logger?.error("error", `初期化エラー: ${err.message}`);
      throw err;
    }

    while (this.isRunning) {
      try {
        if (this.quotaLockManager.isLocked()) {
          await this.handleQuotaLockedState();
        } else {
          await this.pollOnce(false);
        }
      } catch (err: any) {
        console.error(`[Poller] ポーリングエラー:`, err);
        this.logger?.error("error", `ポーリング例外: ${err.message}`);
      }
      await this.sleep(this.intervalMs);
    }
  }

  async stop(): Promise<void> {
    console.log(`[Poller] デーモン停止シグナルを受信しました。実行中のタスク完了を待機します (実行中: ${this.inFlightIssues.size}件)...`);
    this.isRunning = false;
    await this.waitForActiveTasks();
    console.log(`[Poller] 全アクティブタスクが完了しました。`);
    this.logger?.info("daemon_stop", `デーモン停止`);
  }

  async pollOnce(waitForCompletion: boolean = true): Promise<void> {
    if (this.isPolling) {
      return;
    }

    if (!this.projectId) {
      return;
    }

    const availableSlots = this.maxConcurrency - this.inFlightIssues.size;
    if (availableSlots <= 0) {
      console.log(`[Poller] 最大並行数 (${this.maxConcurrency}) に達しているため新規ディスパッチを待機中 (実行中: ${Array.from(this.inFlightIssues).join(", ")})`);
      return;
    }

    this.isPolling = true;
    try {
      let issuesToScan: BacklogIssue[] = [];

      if (this.targetIssueKey) {
        const singleIssue = await this.backlog.getIssue(this.targetIssueKey);
        issuesToScan = [singleIssue];
      } else {
        issuesToScan = await this.backlog.getIssues({
          projectId: [this.projectId],
          sort: "updated",
          order: "asc",
          count: 50,
        });
      }

      const isCustom = this.dispatcher.isCustomStatusMode(this.projectStatuses);

      const actionableIssues = issuesToScan.filter((issue) => {
        // 1. 種別 (Issue Type) フィルター
        if (this.filterOptions?.targetIssueType) {
          if (issue.issueType.name !== this.filterOptions.targetIssueType) {
            return false;
          }
        }

        // 2. カテゴリー (Category) フィルター
        if (this.filterOptions?.targetCategory) {
          const hasMatchingCategory = issue.category?.some(
            (c) => c.name === this.filterOptions!.targetCategory
          );
          if (!hasMatchingCategory) {
            return false;
          }
        }

        // 3. 件名 [AI] タグ必須フィルター
        if (this.filterOptions?.requireAiTag) {
          const hasTag = /\[AI\]/i.test(issue.summary);
          if (!hasTag) {
            return false;
          }
        }

        const role = this.dispatcher.resolveRole(issue, this.projectStatuses);
        return role !== null;
      });

      // 非アクション対象チケットも含め、現在のステータス/件名をキャッシュに追跡（「確認待ち」等）
      for (const issue of issuesToScan) {
        const isActionable = actionableIssues.some((ai) => ai.issueKey === issue.issueKey);
        if (!isActionable) {
          const fingerprint = isCustom
            ? `${issue.status.name}::none::${issue.updated || ""}`
            : `${issue.status.name}::${issue.summary}::none::${issue.updated || ""}`;
          this.issueStatusCache.set(issue.issueKey, fingerprint);
        }
      }

      // 新規に着手可能なチケットを抽出 (既に実行中のものや前回から変更のないものを除外)
      const issuesToDispatch: BacklogIssue[] = [];
      for (const issue of actionableIssues) {
        if (this.inFlightIssues.has(issue.issueKey)) {
          continue; // 既にエージェント実行中
        }

        const role = this.dispatcher.resolveRole(issue, this.projectStatuses);
        const lastFingerprint = this.issueStatusCache.get(issue.issueKey);
        const currentFingerprint = isCustom
          ? `${issue.status.name}::${role || "none"}::${issue.updated || ""}`
          : `${issue.status.name}::${issue.summary}::${role || "none"}::${issue.updated || ""}`;

        if (lastFingerprint === currentFingerprint) {
          continue; // 変更なし
        }

        issuesToDispatch.push(issue);
        if (issuesToDispatch.length >= availableSlots) {
          break;
        }
      }

      if (issuesToDispatch.length === 0) {
        if (this.inFlightIssues.size === 0) {
          process.stdout.write(".");
        }
        return;
      }

      console.log(`\n[Poller] 新規着手可能チケットを検知: ${issuesToDispatch.length}件 (空きスロット: ${availableSlots}/${this.maxConcurrency})`);

      const launchedPromises: Promise<void>[] = [];
      for (const issue of issuesToDispatch) {
        const issueKey = issue.issueKey;
        this.inFlightIssues.add(issueKey);

        const taskPromise = this.executeIssueTask(issue, isCustom)
          .finally(() => {
            this.inFlightIssues.delete(issueKey);
            this.activeTasks.delete(issueKey);
          });

        this.activeTasks.set(issueKey, taskPromise);
        launchedPromises.push(taskPromise);
      }

      if (waitForCompletion && launchedPromises.length > 0) {
        await Promise.allSettled(launchedPromises);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async executeIssueTask(issue: BacklogIssue, isCustom: boolean): Promise<void> {
    const role = this.dispatcher.resolveRole(issue, this.projectStatuses);
    const lastFingerprint = this.issueStatusCache.get(issue.issueKey);
    const currentFingerprint = isCustom
      ? `${issue.status.name}::${role || "none"}::${issue.updated || ""}`
      : `${issue.status.name}::${issue.summary}::${role || "none"}::${issue.updated || ""}`;

    // 人間介入後の再開検知: 「確認待ち」からの復帰時、差し戻しカウンターをリセット
    const wasWaitingConfirmation =
      lastFingerprint &&
      (lastFingerprint.includes("確認待ち") || lastFingerprint.includes("confirmHuman"));

    if (wasWaitingConfirmation) {
      console.log(`[Poller][${issue.issueKey}] 「確認待ち」からの復帰を検知しました。差し戻しカウンターをリセットします`);
      this.dispatcher.resetRejectionCount(issue.issueKey);
      this.logger?.info("issue_detected", `人間確認後の自律再開を検知 (カウンターリセット): ${issue.issueKey}`, {
        issueKey: issue.issueKey,
        data: { previous: lastFingerprint, current: currentFingerprint },
      });
    }

    console.log(`[Poller][${issue.issueKey}] チケット処理開始: [${issue.summary}] (ステータス: "${issue.status.name}", 担当: [${role}]) [並行実行中: ${this.inFlightIssues.size}/${this.maxConcurrency}]`);

    try {
      const result = await this.dispatcher.processIssue(issue, this.projectStatuses);

      if (result.handled) {
        const nextFingerprint = isCustom
          ? `${result.nextStatusTarget || issue.status.name}::${role || "none"}`
          : `${result.nextStatusTarget || issue.status.name}::${result.newSummary || issue.summary}::${role || "none"}`;
        this.issueStatusCache.set(issue.issueKey, nextFingerprint);
      }
      console.log(`[Poller][${issue.issueKey}] チケット処理完了 (結果: ${result.handled ? "成功/更新" : "未処理"})`);
    } catch (err: any) {
      console.error(`[Poller][${issue.issueKey}] チケット処理で例外発生:`, err);
      this.logger?.error("error", `チケット処理例外: ${err.message}`, { issueKey: issue.issueKey });
    }
  }

  async handleQuotaLockedState(): Promise<void> {
    const metadata = this.quotaLockManager.readMetadata();
    if (!metadata) {
      console.warn(`[Poller] クォータロックメタデータが不正なため、ロックを解除します。`);
      this.quotaLockManager.release();
      return;
    }

    const remainingMs = this.quotaLockManager.getTimeUntilResetMs();
    const now = Date.now();

    // ログ抑制: 30秒に1回だけ出力
    if (now - this.lastQuotaLogAt >= 30000) {
      this.lastQuotaLogAt = now;
      const totals = TokenUsageTracker.getTotals();
      const usageInfo =
        totals.totalTokens > 0
          ? ` [累計消費: ${totals.totalTokens.toLocaleString()} tokens (${totals.sessionCount}回)]`
          : "";
      if (remainingMs !== null && remainingMs > 0) {
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        console.log(
          `[Poller] ⏳ クォータ回復待機中 (リセット予定: ${metadata.resetsAt} / 残り 約${remainingMinutes}分)${usageInfo}。Backlog ポーリング休止中... (ロック: ${this.quotaLockManager.getLockFilePath()})`
        );
      } else {
        console.log(
          `[Poller] ⏳ クォータ回復待機中 (定期プローブ中)${usageInfo}。Backlog ポーリング休止中... (ロック: ${this.quotaLockManager.getLockFilePath()})`
        );
      }
    }

    // まだリセット予定時刻に達していない場合はプローブしない
    if (remainingMs !== null && remainingMs > 0) {
      return;
    }

    // リセット予定時刻が到来したか、元々不明の場合: プローブ間隔をチェック
    const lastProbe = metadata.lastProbeAt ? new Date(metadata.lastProbeAt).getTime() : 0;
    if (now - lastProbe < this.quotaProbeIntervalSec * 1000) {
      return;
    }

    // プローブ実行
    console.log(`[Poller] 🔍 クォータ回復チェック（プローブ）を実行します...`);
    const runner = this.dispatcher.getRunner();
    let probeResult: QuotaProbeResult = { recovered: true };

    if (typeof runner.probeQuotaRecovery === "function") {
      probeResult = await runner.probeQuotaRecovery();
    }

    if (probeResult.recovered) {
      console.log(
        `[Poller] 🎉 LLMクォータの回復を確認しました！クォータロックファイルを解除し、Backlogポーリングを再開します。`
      );
      this.logger?.info(
        "quota_recovered",
        `クォータ回復確認: ロック解除 (${this.quotaLockManager.getLockFilePath()})`,
        {
          data: { metadata },
        }
      );
      this.quotaLockManager.release();

      if (this.quotaAutoResume && metadata.issueKey) {
        await this.resumeQuotaInterruptedIssue(metadata);
      }
    } else {
      console.log(
        `[Poller] ⚠️ クォータはまだ回復していません。引き続き休止待機します... (詳細: ${probeResult.errorMessage || "Quota reached"})`
      );
      let newResetsAt = metadata.resetsAt;
      if (probeResult.resetDurationSec) {
        newResetsAt = new Date(Date.now() + probeResult.resetDurationSec * 1000).toISOString();
      }
      this.quotaLockManager.updateMetadata({
        lastProbeAt: new Date().toISOString(),
        probeCount: (metadata.probeCount || 0) + 1,
        resetsAt: newResetsAt,
        resetDurationSec: probeResult.resetDurationSec ?? metadata.resetDurationSec,
        resetDurationText: probeResult.resetDurationText ?? metadata.resetDurationText,
      });
    }
  }

  private getStatusNameForRole(role: AgentRole): string {
    switch (role) {
      case "spec-writer":
        return "詳細設計中";
      case "spec-reviewer":
        return "設計レビュー中";
      case "developer":
        return "実装中";
      case "code-reviewer":
        return "技術レビュー中";
      case "requirement-reviewer":
        return "要件レビュー中";
      default:
        return "処理中";
    }
  }

  private getPhaseTagForRole(role: AgentRole): string {
    switch (role) {
      case "spec-writer":
        return PHASE_TAGS.specWriter;
      case "spec-reviewer":
        return PHASE_TAGS.specReviewer;
      case "developer":
        return PHASE_TAGS.developer;
      case "code-reviewer":
        return PHASE_TAGS.codeReviewer;
      case "requirement-reviewer":
        return PHASE_TAGS.requirementReviewer;
      default:
        return PHASE_TAGS.specWriter;
    }
  }

  private async resumeQuotaInterruptedIssue(metadata: QuotaLockMetadata): Promise<void> {
    try {
      console.log(
        `[Poller][${metadata.issueKey}] 🚀 クォータ回復により中断チケットの自動再開を実行します (担当ロール: [${metadata.role}])`
      );
      const issue = await this.backlog.getIssue(metadata.issueKey);
      const isCustom = this.dispatcher.isCustomStatusMode(this.projectStatuses);
      const role = metadata.role;

      const resumeComment = [
        `### 🚀【クォータ回復検知】自律処理を自動再開します`,
        ``,
        `ローカルプローブにより LLM クォータの回復を確認しました。`,
        `中断していたエージェント **[${role}]** による自律処理を自動的に再開します。`,
      ].join("\n");

      if (isCustom) {
        const targetStatusName = this.getStatusNameForRole(role);
        const targetStatusId =
          this.dispatcher.findStatusIdByName(this.projectStatuses, targetStatusName) ||
          this.dispatcher.findStatusIdByName(this.projectStatuses, "処理中") ||
          2;

        if (typeof this.backlog.updateIssue === "function") {
          await this.backlog.updateIssue(issue.issueKey, {
            statusId: targetStatusId,
            comment: resumeComment,
          });
        } else {
          await this.backlog.updateIssueStatus(issue.issueKey, targetStatusId, resumeComment);
        }
      } else {
        const phaseTag = this.getPhaseTagForRole(role);
        const newSummary = formatSummaryWithPhase(issue.summary, phaseTag);
        const targetStatusId =
          this.dispatcher.findStatusIdByName(this.projectStatuses, "処理中") || 2;

        if (typeof this.backlog.updateIssue === "function") {
          await this.backlog.updateIssue(issue.issueKey, {
            summary: newSummary,
            statusId: targetStatusId,
            comment: resumeComment,
          });
        } else {
          await this.backlog.updateIssueStatus(issue.issueKey, targetStatusId, resumeComment);
        }
      }

      // キャッシュをクリアして次のポーリングで即座に検知・着手させる
      this.issueStatusCache.delete(issue.issueKey);
      console.log(`[Poller][${metadata.issueKey}] 自動再開のステータス更新 & コメント投稿が完了しました`);
    } catch (err: any) {
      console.error(`[Poller][${metadata.issueKey}] 自動再開処理でエラー発生:`, err);
      this.logger?.error("error", `自動再開処理例外: ${err.message}`, { issueKey: metadata.issueKey });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
