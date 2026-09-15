import type { IIssueTracker, TrackedIssue } from "../tracker/types.js";
import { wrapLegacyIssueClient } from "../tracker/factory.js";
import type { WorkflowStep } from "../workflow/types.js";
import { loadWorkflow } from "../workflow/loader.js";
import type { AgentDispatcher } from "./dispatcher.js";
import type { JsonlLogger } from "../logger/jsonl.js";
import { QuotaLockManager, type QuotaLockMetadata } from "./quota-lock.js";
import type { QuotaProbeResult, AgentRole } from "../agents/types.js";
import { TokenUsageTracker } from "../agents/runner.js";
import { ResourceCleaner } from "./cleaner.js";

export interface PollerFilterOptions {
  targetIssueType?: string;
  targetCategory?: string;
  requireAiTag?: boolean;
}

export class IssuePoller {
  private tracker: IIssueTracker;
  private dispatcher: AgentDispatcher;
  private projectKey: string;
  private targetIssueKey?: string;
  private intervalMs: number;
  private maxConcurrency: number;
  private isRunning: boolean = false;
  private isPolling: boolean = false;
  private inFlightIssues: Set<string> = new Set();
  private activeTasks: Map<string, Promise<void>> = new Map();
  private issueStatusCache: Map<string, string> = new Map();
  private logger?: JsonlLogger;
  private filterOptions?: PollerFilterOptions;
  private quotaLockManager: QuotaLockManager;
  private quotaProbeIntervalSec: number;
  private quotaAutoResume: boolean;
  private lastQuotaLogAt: number = 0;
  private cleaner: ResourceCleaner;
  private cleanupIntervalMs: number;
  private lastCleanupAt: number;

  constructor(
    trackerOrClient: IIssueTracker | object,
    dispatcher: AgentDispatcher,
    projectKey: string,
    targetIssueKey?: string,
    intervalSec: number = 10,
    logger?: JsonlLogger,
    filterOptions?: PollerFilterOptions,
    maxConcurrency: number = 2,
    quotaLockManager?: QuotaLockManager,
    quotaProbeIntervalSec: number = 300,
    quotaAutoResume: boolean = true,
    cleaner?: ResourceCleaner,
    cleanupIntervalMinutes?: number
  ) {
    this.tracker = wrapLegacyIssueClient(trackerOrClient, undefined, projectKey);
    this.dispatcher = dispatcher;
    if (typeof this.dispatcher.setTracker === "function") {
      this.dispatcher.setTracker(this.tracker);
    }
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
    this.cleaner =
      cleaner ||
      new ResourceCleaner(
        this.tracker,
        dispatcher.getWorktreeManager(),
        dispatcher.getGitHubService(),
        this.logger
      );
    const intervalMins =
      cleanupIntervalMinutes ??
      parseInt(process.env.CLEANUP_INTERVAL_MINUTES || "30", 10);
    this.cleanupIntervalMs = Math.max(1, intervalMins) * 60 * 1000;
    // 起動直後は初回ポーリングを最優先にし、定期間隔後に最初のクリーンアップを実行
    this.lastCleanupAt = Date.now();
  }

  getCleaner(): ResourceCleaner {
    return this.cleaner;
  }

  async runCleanupNow(): Promise<void> {
    await this.cleaner.cleanupCompletedIssues(this.inFlightIssues);
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
    await this.tracker.init();
    console.log(`[Poller] トラッカー初期化成功 (${this.tracker.trackerType})`);

    const isCustom = this.tracker.isCustomStatusMode
      ? this.tracker.isCustomStatusMode()
      : this.dispatcher.isCustomStatusMode();
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
      // 起動時初回クリーンアップ（停止中に完了・マージされたチケットのリソースや孤児コンテナを非同期でお掃除）
      this.cleaner
        .cleanupCompletedIssues(this.inFlightIssues)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Poller] 起動時リソースクリーンアップで例外: ${msg}`);
        });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Poller] 初期化エラー (プロジェクトまたはステータス取得失敗):`, err);
      this.logger?.error("error", `初期化エラー: ${errMsg}`);
      throw err;
    }

    while (this.isRunning) {
      try {
        if (this.quotaLockManager.isLocked()) {
          await this.handleQuotaLockedState();
        } else {
          await this.pollOnce(false);
        }

        // 定期リソースクリーンアップ（完了チケット & クローズ済み PR の worktree / Docker 停止）
        const now = Date.now();
        if (now - this.lastCleanupAt >= this.cleanupIntervalMs) {
          this.lastCleanupAt = now;
          this.cleaner
            .cleanupCompletedIssues(this.inFlightIssues)
            .catch((cleanupErr: unknown) => {
              const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              console.warn(`[Poller] 定期リソースクリーンアップで例外: ${msg}`);
            });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Poller] ポーリングエラー:`, err);
        this.logger?.error("error", `ポーリング例外: ${errMsg}`);
      }
      await this.sleep(this.intervalMs);
    }
  }

  async stop(): Promise<void> {
    console.log(`[Poller] デーモン停止シグナルを受信しました。実行中のタスク完了を待機します (実行中: ${this.inFlightIssues.size}件)...`);
    this.isRunning = false;
    await this.waitForActiveTasks();
    console.log(`[Poller] 全アクティブタスクが完了しました。`);

    // 停止時リソースクリーンアップ
    try {
      await this.cleaner.cleanupCompletedIssues(this.inFlightIssues);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Poller] 停止時リソースクリーンアップで例外: ${errMsg}`);
    }

    this.logger?.info("daemon_stop", `デーモン停止`);
  }

  async pollOnce(waitForCompletion: boolean = true): Promise<void> {
    if (this.isPolling) {
      return;
    }

    const availableSlots = this.maxConcurrency - this.inFlightIssues.size;
    if (availableSlots <= 0) {
      console.log(`[Poller] 最大並行数 (${this.maxConcurrency}) に達しているため新規ディスパッチを待機中 (実行中: ${Array.from(this.inFlightIssues).join(", ")})`);
      return;
    }

    this.isPolling = true;
    try {
      let issuesToScan: TrackedIssue[] = [];
      let actionableIssues: TrackedIssue[] = [];

      const workflowDef = loadWorkflow({ projectKey: this.projectKey });
      if (this.targetIssueKey) {
        const singleIssue = await this.tracker.getIssue(this.targetIssueKey, workflowDef);
        issuesToScan = [singleIssue];
        if (singleIssue.lifecycleState === "in_progress" && singleIssue.currentStepName) {
          actionableIssues = [singleIssue];
        }
      } else {
        if (typeof this.tracker.fetchCandidateIssues === "function") {
          issuesToScan = await this.tracker.fetchCandidateIssues(workflowDef, this.filterOptions);
          actionableIssues = issuesToScan.filter(
            (i) => i.lifecycleState === "in_progress" && Boolean(i.currentStepName)
          );
        } else {
          actionableIssues = await this.tracker.fetchActionableIssues(workflowDef, this.filterOptions);
          issuesToScan = actionableIssues;
        }
      }

      const isCustom = this.dispatcher.isCustomStatusMode();

      // 非アクション対象チケットも含め、現在のステータス/件名をキャッシュに追跡（「確認待ち」等）
      for (const issue of issuesToScan) {
        const issueKey = issue.key;
        const isActionable = actionableIssues.some((ai) => ai.key === issueKey);
        if (!isActionable) {
          const fingerprint = isCustom
            ? `${issue.rawStatusName}::none::${issue.updatedAt}`
            : `${issue.rawStatusName}::${issue.rawTitle}::none::${issue.updatedAt}`;
          this.issueStatusCache.set(issueKey, fingerprint);
        }
      }

      // 新規に着手可能なチケットを抽出 (既に実行中のものや前回から変更のないものを除外)
      const issuesToDispatch: TrackedIssue[] = [];
      for (const issue of actionableIssues) {
        const issueKey = issue.key;
        if (this.inFlightIssues.has(issueKey)) {
          continue; // 既にエージェント実行中
        }

        const role = this.dispatcher.resolveRole(issue);
        const lastFingerprint = this.issueStatusCache.get(issueKey);
        const currentFingerprint = isCustom
          ? `${issue.rawStatusName}::${role || "none"}::${issue.updatedAt}`
          : `${issue.rawStatusName}::${issue.rawTitle}::${role || "none"}::${issue.updatedAt}`;

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
        const issueKey = issue.key;
        this.inFlightIssues.add(issueKey);

        const taskPromise = this.executeIssueTask(issue)
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

  private async executeIssueTask(issue: TrackedIssue): Promise<void> {
    const issueKey = issue.key;
    const issueSummary = issue.rawTitle;
    const statusName = issue.rawStatusName;
    const updatedAt = issue.updatedAt;

    const isCustom = this.dispatcher.isCustomStatusMode();
    const role = this.dispatcher.resolveRole(issue);
    const lastFingerprint = this.issueStatusCache.get(issueKey);
    const currentFingerprint = isCustom
      ? `${statusName}::${role || "none"}::${updatedAt || ""}`
      : `${statusName}::${issueSummary}::${role || "none"}::${updatedAt || ""}`;

    // 人間介入後の再開検知: 「確認待ち」からの復帰時、差し戻しカウンターをリセット
    const wasWaitingConfirmation =
      lastFingerprint &&
      (lastFingerprint.includes("確認待ち") || lastFingerprint.includes("confirmHuman"));

    if (wasWaitingConfirmation) {
      console.log(`[Poller][${issueKey}] 「確認待ち」からの復帰を検知しました。差し戻しカウンターをリセットします`);
      this.dispatcher.resetRejectionCount(issueKey);
      this.logger?.info("issue_detected", `人間確認後の自律再開を検知 (カウンターリセット): ${issueKey}`, {
        issueKey,
        data: { previous: lastFingerprint, current: currentFingerprint },
      });
    }

    console.log(`[Poller][${issueKey}] チケット処理開始: [${issueSummary}] (ステータス: "${statusName}", 担当: [${role}]) [並行実行中: ${this.inFlightIssues.size}/${this.maxConcurrency}]`);

    try {
      const result = await this.dispatcher.processIssue(issue);

      if (result.handled) {
        const nextFingerprint = isCustom
          ? `${result.nextStatusTarget || statusName}::${role || "none"}`
          : `${result.nextStatusTarget || statusName}::${result.newSummary || issueSummary}::${role || "none"}`;
        this.issueStatusCache.set(issueKey, nextFingerprint);
      }
      console.log(`[Poller][${issueKey}] チケット処理完了 (結果: ${result.handled ? "成功/更新" : "未処理"})`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Poller][${issueKey}] チケット処理で例外発生:`, err);
      this.logger?.error("error", `チケット処理例外: ${errMsg}`, { issueKey });
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
          `[Poller] ⏳ クォータ回復待機中 (リセット予定: ${metadata.resetsAt} / 残り 約${remainingMinutes}分)${usageInfo}。チケット ポーリング休止中... (ロック: ${this.quotaLockManager.getLockFilePath()})`
        );
      } else {
        console.log(
          `[Poller] ⏳ クォータ回復待機中 (定期プローブ中)${usageInfo}。チケット ポーリング休止中... (ロック: ${this.quotaLockManager.getLockFilePath()})`
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
        `[Poller] 🎉 LLMクォータの回復を確認しました！クォータロックファイルを解除し、チケットポーリングを再開します。`
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

  private async resumeQuotaInterruptedIssue(metadata: QuotaLockMetadata): Promise<void> {
    try {
      console.log(
        `[Poller][${metadata.issueKey}] 🚀 クォータ回復により中断チケットの自動再開を実行します (担当ロール: [${metadata.role}])`
      );
      const role = metadata.role;

      const resumeComment = [
        `### 🚀【クォータ回復検知】自律処理を自動再開します`,
        ``,
        `ローカルプローブにより LLM クォータの回復を確認しました。`,
        `中断していたエージェント **[${role}]** による自律処理を自動的に再開します。`,
      ].join("\n");

      const workflowDef = loadWorkflow({ projectKey: this.projectKey });
      const issue = await this.tracker.getIssue(metadata.issueKey, workflowDef);
      const stepDef =
        workflowDef.steps[role] ||
        Object.values(workflowDef.steps).find((s: WorkflowStep) => s.role === role || s.name === role);

      if (stepDef) {
        await this.tracker.updateIssueStep(issue.key, stepDef, {
          comment: resumeComment,
        });
      } else {
        await this.tracker.updateLifecycle(issue.key, "in_progress", {
          comment: resumeComment,
        });
      }
      this.issueStatusCache.delete(issue.key);
      console.log(`[Poller][${metadata.issueKey}] 自動再開のステータス更新 & コメント投稿が完了しました`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Poller][${metadata.issueKey}] 自動再開処理でエラー発生:`, err);
      this.logger?.error("error", `自動再開処理例外: ${errMsg}`, { issueKey: metadata.issueKey });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export { IssuePoller as BacklogPoller };
