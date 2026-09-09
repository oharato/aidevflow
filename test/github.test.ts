import { GitHubService } from "../src/git/github.js";

async function runGitHubTests() {
  console.log("=== GitHubService 単体テスト開始 ===");

  const service = new GitHubService();

  // DRY_RUN テスト
  const prUrl = await service.ensurePullRequest("/mock/worktree", {
    issueKey: "STUDY-3",
    summary: "AIエージェントによる自動開発の検証",
    description: "チケットの詳細内容",
    dryRun: true,
  });

  if (!prUrl || !prUrl.includes("pull/999")) {
    throw new Error(`DRY_RUN PR URL が不正です: ${prUrl}`);
  }
  console.log(`✓ DRY_RUN PR URL 取得成功: ${prUrl}`);

  console.log("✓ GitHubService 全テスト合格！");
}

runGitHubTests().catch((err) => {
  console.error("GitHub テスト失敗:", err);
  process.exit(1);
});
