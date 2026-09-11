import type { BacklogClient } from "../backlog/client.js";
import type { AgentDispatcher } from "./dispatcher.js";
import type { BacklogStatus, BacklogIssue } from "../backlog/types.js";
import type { JsonlLogger } from "../logger/jsonl.js";

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

  constructor(
    backlog: BacklogClient,
    dispatcher: AgentDispatcher,
    projectKey: string,
    targetIssueKey?: string,
    intervalSec: number = 10,
    logger?: JsonlLogger,
    filterOptions?: PollerFilterOptions,
    maxConcurrency: number = 2
  ) {
    this.backlog = backlog;
    this.dispatcher = dispatcher;
    this.projectKey = projectKey;
    this.targetIssueKey = targetIssueKey;
    this.intervalMs = intervalSec * 1000;
    this.logger = logger;
    this.filterOptions = filterOptions;
    this.maxConcurrency = Math.max(1, maxConcurrency);
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
        await this.pollOnce(false);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
