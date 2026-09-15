import { loadConfig } from "../config.js";
import { createTracker } from "../tracker/index.js";
import { GitWorktreeManager } from "../git/worktree.js";
import { GitHubService } from "../git/github.js";
import { ResourceCleaner } from "../daemon/cleaner.js";
import { JsonlLogger } from "../logger/jsonl.js";

async function main() {
  console.log("==================================================");
  console.log("   aidevflow: リソースクリーンアップ (手動実行)   ");
  console.log("==================================================");

  const config = loadConfig();
  const logger = new JsonlLogger(config.logFilePath);

  let tracker;
  try {
    tracker = createTracker(config);
    await tracker.init();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(errMsg);
    process.exit(1);
  }

  const worktreeManager = new GitWorktreeManager(config.aidevflowHome);
  const githubService = new GitHubService();
  const cleaner = new ResourceCleaner(tracker, worktreeManager, githubService, logger);

  console.log(`\nワークツリーディレクトリ: ${worktreeManager.getWorktreesDir()}`);
  console.log(`トラッカー種別: ${tracker.trackerType}\n`);

  const summary = await cleaner.cleanupCompletedIssues(new Set());

  console.log("\n--------------------------------------------------");
  console.log(`スキャン対象チケット: ${summary.scannedCount}件`);
  console.log(`クリーンアップ完了:   ${summary.cleanedCount}件`);
  console.log(`スキップ (未完了/PRオープン中): ${summary.skippedCount}件`);
  console.log("--------------------------------------------------");
}

main().catch((err) => {
  console.error("クリーンアップスクリプトでエラーが発生しました:", err);
  process.exit(1);
});
