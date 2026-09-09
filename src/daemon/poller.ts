import type { BacklogClient } from "../backlog/client.js";
import type { AgentDispatcher } from "./dispatcher.js";
import type { BacklogStatus, BacklogIssue } from "../backlog/types.js";
import type { JsonlLogger } from "../logger/jsonl.js";

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

  constructor(
    backlog: BacklogClient,
    dispatcher: AgentDispatcher,
    projectKey: string,
    targetIssueKey?: string,
    intervalSec: number = 10,
    logger?: JsonlLogger
  ) {
    this.backlog = backlog;
    this.dispatcher = dispatcher;
    this.projectKey = projectKey;
    this.targetIssueKey = targetIssueKey;
    this.intervalMs = intervalSec * 1000;
    this.logger = logger;
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

      const actionableIssues = issuesToScan.filter((issue) => {
        const role = this.dispatcher.resolveRoleFromStatus(issue.status.name);
        return role !== null;
      });

      // 非アクション対象チケットも含め、現在のステータスをキャッシュに追跡（「確認待ち」等）
      for (const issue of issuesToScan) {
        const isActionable = actionableIssues.some((ai) => ai.issueKey === issue.issueKey);
        if (!isActionable) {
          this.issueStatusCache.set(issue.issueKey, issue.status.name);
        }
      }

      if (actionableIssues.length === 0) {
        process.stdout.write(".");
        return;
      }

      console.log(`\n[Poller] 処理対象のチケットを検知しました: ${actionableIssues.length}件`);

      for (const issue of actionableIssues) {
        const lastStatus = this.issueStatusCache.get(issue.issueKey);
        const currentStatus = issue.status.name;

        if (lastStatus === currentStatus) {
          continue;
        }

        // 人間介入後の再開検知: 「確認待ち」からのステータス変更時、差し戻しカウンターをリセット
        if (lastStatus && lastStatus.includes("確認待ち")) {
          console.log(`[Poller] 「確認待ち」からの復帰を検知しました。差し戻しカウンターをリセットします: ${issue.issueKey}`);
          this.dispatcher.resetRejectionCount(issue.issueKey);
          this.logger?.info("issue_detected", `人間確認後の自律再開を検知 (カウンターリセット): ${issue.issueKey}`, {
            issueKey: issue.issueKey,
            data: { previousStatus: lastStatus, currentStatus },
          });
        }

        console.log(`[Poller] チケット処理開始: ${issue.issueKey} (ステータス: "${currentStatus}")`);
        const result = await this.dispatcher.processIssue(issue, this.projectStatuses);

        if (result.handled) {
          this.issueStatusCache.set(issue.issueKey, result.nextStatusTarget || currentStatus);
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
