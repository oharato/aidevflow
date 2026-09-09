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
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
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
    filterOptions?: PollerFilterOptions
  ) {
    this.backlog = backlog;
    this.dispatcher = dispatcher;
    this.projectKey = projectKey;
    this.targetIssueKey = targetIssueKey;
    this.intervalMs = intervalSec * 1000;
    this.logger = logger;
    this.filterOptions = filterOptions;
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
    console.log(`[Poller] デーモンを開始しました。プロジェクト: "${this.projectKey}", ポーリング間隔: ${this.intervalMs / 1000}s`);
    if (this.targetIssueKey) {
      console.log(`[Poller] (特定チケット限定モード: ${this.targetIssueKey})`);
    }

    this.logger?.info("daemon_start", `デーモン起動: プロジェクト "${this.projectKey}"`, {
      data: { projectKey: this.projectKey, targetIssueKey: this.targetIssueKey },
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
        await this.pollOnce();
      } catch (err: any) {
        console.error(`[Poller] ポーリングエラー:`, err);
        this.logger?.error("error", `ポーリング例外: ${err.message}`);
      }
      await this.sleep(this.intervalMs);
    }
  }

  stop(): void {
    console.log(`[Poller] デーモン停止シグナルを受信しました。`);
    this.isRunning = false;
    this.logger?.info("daemon_stop", `デーモン停止`);
  }

  async pollOnce(): Promise<void> {
    if (this.isProcessing) {
      console.log(`[Poller] 前回のタスクが実行中のため、今回のポーリングはスキップします。`);
      return;
    }

    if (!this.projectId) {
      return;
    }

    this.isProcessing = true;
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
            ? issue.status.name
            : `${issue.status.name}::${issue.summary}`;
          this.issueStatusCache.set(issue.issueKey, fingerprint);
        }
      }

      if (actionableIssues.length === 0) {
        process.stdout.write(".");
        return;
      }

      console.log(`\n[Poller] 処理対象のチケットを検知しました: ${actionableIssues.length}件`);

      for (const issue of actionableIssues) {
        const lastFingerprint = this.issueStatusCache.get(issue.issueKey);
        const currentFingerprint = isCustom
          ? issue.status.name
          : `${issue.status.name}::${issue.summary}`;

        if (lastFingerprint === currentFingerprint) {
          continue;
        }

        // 人間介入後の再開検知: 「確認待ち」からの復帰時、差し戻しカウンターをリセット
        const wasWaitingConfirmation =
          lastFingerprint &&
          (lastFingerprint.includes("確認待ち") || lastFingerprint.includes("confirmHuman"));

        if (wasWaitingConfirmation) {
          console.log(`[Poller] 「確認待ち」からの復帰を検知しました。差し戻しカウンターをリセットします: ${issue.issueKey}`);
          this.dispatcher.resetRejectionCount(issue.issueKey);
          this.logger?.info("issue_detected", `人間確認後の自律再開を検知 (カウンターリセット): ${issue.issueKey}`, {
            issueKey: issue.issueKey,
            data: { previous: lastFingerprint, current: currentFingerprint },
          });
        }

        console.log(`[Poller] チケット処理開始: ${issue.issueKey} [${issue.summary}] (ステータス: "${issue.status.name}")`);
        const result = await this.dispatcher.processIssue(issue, this.projectStatuses);

        if (result.handled) {
          const nextFingerprint = isCustom
            ? (result.nextStatusTarget || issue.status.name)
            : `${result.nextStatusTarget || issue.status.name}::${result.newSummary || issue.summary}`;
          this.issueStatusCache.set(issue.issueKey, nextFingerprint);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
