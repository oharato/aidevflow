import { loadConfig } from "./config.js";
import { BacklogClient } from "./backlog/client.js";
import { AgyRunner, ClaudeCliRunner, MockRunner } from "./agents/runner.js";
import { AgentDispatcher } from "./daemon/dispatcher.js";
import { BacklogPoller } from "./daemon/poller.js";
import { JsonlLogger } from "./logger/jsonl.js";
import { GitWorktreeManager } from "./git/worktree.js";
import { GitHubService } from "./git/github.js";
import { ProcessLock } from "./daemon/lock.js";
import { QuotaLockManager } from "./daemon/quota-lock.js";

async function main() {
  console.log("==================================================");
  console.log("       aidevflow: Backlog AI Agent Daemon         ");
  console.log("==================================================");

  const lock = new ProcessLock(".aidevflow.lock");
  const lockResult = lock.acquire();

  if (!lockResult.success) {
    console.error("==================================================");
    console.error("【多重起動エラー】aidevflow は既に起動しています！");
    if (lockResult.existingLock) {
      console.error(`  - 実行中 PID: ${lockResult.existingLock.pid}`);
      console.error(`  - 起動日時: ${lockResult.existingLock.startedAt}`);
      if (lockResult.existingLock.command) {
        console.error(`  - コマンド: ${lockResult.existingLock.command}`);
      }
    }
    console.error(`  - ロックファイル: ${lock.getLockFilePath()}`);
    console.error("多重起動によるワークツリー競合やステータス上書きを防ぐため、起動を中断しました。");
    console.error("既存のプロセスを停止するか、確認の上再実行してください。");
    console.error("==================================================");
    process.exit(1);
  }

  if (lockResult.cleanedStaleLock) {
    console.log("[Lock] 停止した前回のロックファイルを検知し、自動クリーンアップしました。");
  }
  lock.registerCleanupHandlers();

  const config = loadConfig();
  const logger = new JsonlLogger(config.logFilePath);
  console.log(`[Logger] JSONLログ出力先: ${logger.getLogFilePath()}`);
  console.log(`[Worktree] ベース作業ディレクトリ: ${config.aidevflowHome}`);

  if (!config.backlogApiKey) {
    console.error("【エラー】BACKLOG_API_KEY が設定されていません。");
    console.error(".env ファイルに BACKLOG_API_KEY=xxx を設定してください。");
    console.error("設定例は .env.example を参照してください。");
    logger.error("error", "BACKLOG_API_KEY 未設定による起動失敗");
    lock.release();
    process.exit(1);
  }

  const backlog = new BacklogClient(
    config.backlogSpaceId,
    config.backlogDomain,
    config.backlogApiKey
  );

  let runner;
  if (config.agentRunner === "mock") {
    runner = new MockRunner();
  } else if (config.agentRunner === "claude") {
    runner = new ClaudeCliRunner(config.agentWorkDir);
  } else {
    runner = new AgyRunner(
      config.agentWorkDir,
      config.agyEffort || "low",
      config.agentTimeout,
      config.agyModel,
      config.agyReviewModel
    );
  }

  const worktreeManager = new GitWorktreeManager(config.aidevflowHome);
  const githubService = new GitHubService();
  const quotaLockManager = new QuotaLockManager(config.quotaLockFilePath);

  if (quotaLockManager.isLocked()) {
    const meta = quotaLockManager.readMetadata();
    console.warn("==================================================");
    console.warn("⚠️ 【クォータ制限中】ローカルのクォータロックファイルを検知しました");
    console.warn(`  - ロックファイル: ${quotaLockManager.getLockFilePath()}`);
    if (meta) {
      console.warn(`  - 発生日時: ${meta.lockedAt}`);
      console.warn(`  - 対象チケット: ${meta.issueKey} (ロール: ${meta.role})`);
      if (meta.resetsAt) {
        console.warn(`  - リセット予定: ${meta.resetsAt} (${meta.resetDurationText || ""})`);
      }
    }
    console.warn("  ※ デーモン起動後、Backlogポーリングを休止し、クォータ回復監視モードで待機します。");
    console.warn("  ※ 手動で即座に解除する場合は、上記ロックファイルを削除してください。");
    console.warn("==================================================");
  }

  const dispatcher = new AgentDispatcher(
    backlog,
    runner,
    config.defaultRepoPath || config.agentWorkDir,
    config.dryRun,
    logger,
    worktreeManager,
    githubService,
    config.maxRejectionCount,
    undefined,
    quotaLockManager
  );

  const poller = new BacklogPoller(
    backlog,
    dispatcher,
    config.backlogProjectKey,
    config.backlogIssueKey,
    config.pollIntervalSec,
    logger,
    {
      targetIssueType: config.targetIssueType,
      targetCategory: config.targetCategory,
      requireAiTag: config.requireAiTag,
    },
    config.maxConcurrency,
    quotaLockManager,
    config.quotaProbeIntervalSec,
    config.quotaAutoResume
  );

  const handleShutdown = async () => {
    console.log("\nシャットダウン要求を受信しました。終了処理を実行します...");
    await poller.stop();
    lock.release();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    handleShutdown().catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    handleShutdown().catch(() => process.exit(1));
  });

  await poller.start();
}

main().catch((err) => {
  console.error("予期せぬエラーでデーモンが停止しました:", err);
  try {
    const lock = new ProcessLock(".aidevflow.lock");
    lock.release();
  } catch {}
  process.exit(1);
});
