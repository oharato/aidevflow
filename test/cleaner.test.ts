import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ResourceCleaner } from "../src/daemon/cleaner.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { IGitHubService, PullRequestState } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../src/backlog/types.js";

describe("ResourceCleaner (完了チケット & クローズ済みPRのリソース自動クリーンアップ)", () => {
  let tempDir: string;
  let worktreesDir: string;
  let reposDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-cleaner-test-"));
    worktreesDir = path.join(tempDir, "worktrees");
    reposDir = path.join(tempDir, "repos");
    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(reposDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const dummyStatuses: BacklogStatus[] = [
    { id: 1, projectId: 100, name: "未対応", color: "#ed8077", displayOrder: 1 },
    { id: 2, projectId: 100, name: "処理中", color: "#4488c5", displayOrder: 2 },
    { id: 3, projectId: 100, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
    { id: 4, projectId: 100, name: "完了", color: "#b0be3c", displayOrder: 4 },
  ];

  it("チケットが「完了」かつ PR が MERGED の場合、worktree および Docker Compose がクリーンアップされること", async () => {
    const issueKey = "STUDY-10";
    const issueDir = path.join(worktreesDir, issueKey);
    const repoDir = path.join(issueDir, "my-app");
    fs.mkdirSync(repoDir, { recursive: true });

    // ダミーの docker-compose.yml を作成
    const composePath = path.join(repoDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  web:\n    image: nginx\n");

    const mockBacklog = {
      getIssue: async (key: string): Promise<BacklogIssue> => ({
        id: 10,
        projectId: 100,
        issueKey: key,
        keyId: 10,
        issueType: { id: 1, name: "タスク" },
        summary: "完了したタスク",
        description: "説明",
        status: dummyStatuses[3], // 完了 (id=4)
        createdUser: { id: 1, name: "User" },
        created: "2026-09-01T00:00:00Z",
        updated: "2026-09-12T00:00:00Z",
      }),
    } as unknown as BacklogClient;

    let removedIssueKeys: string[] = [];
    const mockWorktreeManager = {
      getWorktreesDir: () => worktreesDir,
      getReposDir: () => reposDir,
      listIssueKeysWithWorktrees: () => [issueKey],
      getIssueWorktreeDirs: (_k: string) => [
        { repoName: "my-app", worktreeDir: repoDir, repoPath: path.join(reposDir, "my-app") },
      ],
      removeIssueWorktrees: async (k: string) => {
        removedIssueKeys.push(k);
        fs.rmSync(issueDir, { recursive: true, force: true });
      },
    } as unknown as GitWorktreeManager;

    const mockGitHub = {
      getPullRequestState: async (_w: string, _b?: string): Promise<PullRequestState> => "MERGED",
      ensurePullRequest: async () => null,
      ensurePullRequests: async () => [],
    } as IGitHubService;

    const cleaner = new ResourceCleaner(mockBacklog, mockWorktreeManager, mockGitHub);

    // stopDockerCompose をスパイして実際の docker コマンド呼び出しをモック
    const stopDockerSpy = vi.spyOn(cleaner, "stopDockerCompose").mockResolvedValue([composePath]);

    const summary = await cleaner.cleanupCompletedIssues(new Set(), dummyStatuses);

    expect(summary.scannedCount).toBe(1);
    expect(summary.cleanedCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(removedIssueKeys).toContain("STUDY-10");
    expect(stopDockerSpy).toHaveBeenCalledWith(issueDir);
    expect(fs.existsSync(issueDir)).toBe(false);
  });

  it("チケットが「完了」だが PR が OPEN の場合、クリーンアップされず保護されること", async () => {
    const issueKey = "STUDY-11";
    const issueDir = path.join(worktreesDir, issueKey);
    const repoDir = path.join(issueDir, "my-app");
    fs.mkdirSync(repoDir, { recursive: true });

    const mockBacklog = {
      getIssue: async (key: string): Promise<BacklogIssue> => ({
        id: 11,
        projectId: 100,
        issueKey: key,
        keyId: 11,
        issueType: { id: 1, name: "タスク" },
        summary: "完了ステータスだがPR未マージ",
        description: "説明",
        status: dummyStatuses[3], // 完了
        createdUser: { id: 1, name: "User" },
        created: "2026-09-01T00:00:00Z",
        updated: "2026-09-12T00:00:00Z",
      }),
    } as unknown as BacklogClient;

    let removed = false;
    const mockWorktreeManager = {
      getWorktreesDir: () => worktreesDir,
      getReposDir: () => reposDir,
      listIssueKeysWithWorktrees: () => [issueKey],
      getIssueWorktreeDirs: (_k: string) => [
        { repoName: "my-app", worktreeDir: repoDir, repoPath: path.join(reposDir, "my-app") },
      ],
      removeIssueWorktrees: async () => {
        removed = true;
      },
    } as unknown as GitWorktreeManager;

    const mockGitHub = {
      getPullRequestState: async (): Promise<PullRequestState> => "OPEN",
      ensurePullRequest: async () => null,
      ensurePullRequests: async () => [],
    } as IGitHubService;

    const cleaner = new ResourceCleaner(mockBacklog, mockWorktreeManager, mockGitHub);
    const summary = await cleaner.cleanupCompletedIssues(new Set(), dummyStatuses);

    expect(summary.cleanedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(removed).toBe(false);
    expect(fs.existsSync(issueDir)).toBe(true);
  });

  it("チケットが「処理中」または「処理済み」（未完了）の場合、PRがCLOSEDでもクリーンアップされないこと", async () => {
    const issueKey = "STUDY-12";
    const issueDir = path.join(worktreesDir, issueKey);
    const repoDir = path.join(issueDir, "my-app");
    fs.mkdirSync(repoDir, { recursive: true });

    const mockBacklog = {
      getIssue: async (key: string): Promise<BacklogIssue> => ({
        id: 12,
        projectId: 100,
        issueKey: key,
        keyId: 12,
        issueType: { id: 1, name: "タスク" },
        summary: "処理中タスク",
        description: "説明",
        status: dummyStatuses[2], // 処理済み (人間レビュー待ち)
        createdUser: { id: 1, name: "User" },
        created: "2026-09-01T00:00:00Z",
        updated: "2026-09-12T00:00:00Z",
      }),
    } as unknown as BacklogClient;

    let removed = false;
    const mockWorktreeManager = {
      getWorktreesDir: () => worktreesDir,
      getReposDir: () => reposDir,
      listIssueKeysWithWorktrees: () => [issueKey],
      getIssueWorktreeDirs: (_k: string) => [
        { repoName: "my-app", worktreeDir: repoDir, repoPath: path.join(reposDir, "my-app") },
      ],
      removeIssueWorktrees: async () => {
        removed = true;
      },
    } as unknown as GitWorktreeManager;

    const mockGitHub = {
      getPullRequestState: async (): Promise<PullRequestState> => "CLOSED",
      ensurePullRequest: async () => null,
      ensurePullRequests: async () => [],
    } as IGitHubService;

    const cleaner = new ResourceCleaner(mockBacklog, mockWorktreeManager, mockGitHub);
    const summary = await cleaner.cleanupCompletedIssues(new Set(), dummyStatuses);

    expect(summary.cleanedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(removed).toBe(false);
  });

  it("現在実行中（inFlightIssues に含まれる）チケットは保護されること", async () => {
    const issueKey = "STUDY-13";
    const issueDir = path.join(worktreesDir, issueKey);
    fs.mkdirSync(issueDir, { recursive: true });

    const mockBacklog = {
      getIssue: vi.fn(),
    } as unknown as BacklogClient;

    const mockWorktreeManager = {
      getWorktreesDir: () => worktreesDir,
      listIssueKeysWithWorktrees: () => [issueKey],
      getIssueWorktreeDirs: () => [],
      removeIssueWorktrees: vi.fn(),
    } as unknown as GitWorktreeManager;

    const mockGitHub = {
      getPullRequestState: vi.fn(),
    } as unknown as IGitHubService;

    const cleaner = new ResourceCleaner(mockBacklog, mockWorktreeManager, mockGitHub);
    const inFlight = new Set([issueKey]);
    const summary = await cleaner.cleanupCompletedIssues(inFlight, dummyStatuses);

    expect(summary.cleanedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    // 実行中チケットは Backlog API すら呼ばずに即座にスキップされること
    expect(mockBacklog.getIssue).not.toHaveBeenCalled();
  });

  it("worktrees ディレクトリに対象チケットが存在しない場合は Backlog API を呼ばず即座に終了すること", async () => {
    const mockBacklog = {
      getIssue: vi.fn(),
    } as unknown as BacklogClient;

    const mockWorktreeManager = {
      getWorktreesDir: () => worktreesDir,
      listIssueKeysWithWorktrees: () => [],
    } as unknown as GitWorktreeManager;

    const cleaner = new ResourceCleaner(mockBacklog, mockWorktreeManager, {} as any);
    const summary = await cleaner.cleanupCompletedIssues();

    expect(summary.scannedCount).toBe(0);
    expect(summary.cleanedCount).toBe(0);
    expect(mockBacklog.getIssue).not.toHaveBeenCalled();
  });
});
