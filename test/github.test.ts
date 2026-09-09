import { describe, it, expect } from "vitest";
import { GitHubService } from "../src/git/github.js";

describe("GitHubService", () => {
  it("DRY_RUN モードでシミュレートPR URLを取得できること", async () => {
    const service = new GitHubService();

    const prUrl = await service.ensurePullRequest("/mock/worktree", {
      issueKey: "STUDY-3",
      summary: "AIエージェントによる自動開発の検証",
      description: "チケットの詳細内容",
      dryRun: true,
    });

    expect(prUrl).toBeDefined();
    expect(prUrl).toContain("pull/999");
  });
});
