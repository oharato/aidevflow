import { loadConfig } from "../config.js";
import { BacklogClient } from "../backlog/client.js";
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

  if (!config.backlogApiKey) {
    console.error("【エラー】BACKLOG_API_KEY が設定されていません。");
    process.exit(1);
  }

  const backlog = new BacklogClient(
    config.backlogSpaceId,
    config.backlogDomain,
    config.backlogApiKey
  );

  const worktreeManager = new GitWorktreeManager();
  const githubService = new GitHubService();
  const cleaner = new ResourceCleaner(backlog, worktreeManager, githubService, logger);

  let projectStatuses;
  try {
    const project = await backlog.getProject(config.backlogProjectKey);
    projectStatuses = await backlog.getProjectStatuses(project.id);
    console.log(`\nワークツリーディレクトリ: ${worktreeManager.getWorktreesDir()}`);
    console.log(`対象プロジェクト: ${project.name} (${config.backlogProjectKey})\n`);
  } catch (err: any) {
    console.warn(`プロジェクト情報取得警告: ${err.message}`);
  }

  const summary = await cleaner.cleanupCompletedIssues(new Set(), projectStatuses);

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
