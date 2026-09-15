import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const runCommandMock = vi.fn();
vi.mock("../src/git/exec.js", () => ({
  runCommand: (...args: unknown[]) => runCommandMock(...args),
  isSafeRefName: (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
}));

import { ResourceCleaner } from "../src/daemon/cleaner.js";
import { BacklogTracker } from "../src/tracker/adapters/backlog-tracker.js";
import { BUILTIN_DEFAULT_WORKFLOW } from "../src/workflow/loader.js";
import type { GitWorktreeManager } from "../src/git/worktree.js";
import type { IGitHubService, PullRequestState } from "../src/git/github.js";
import type { BacklogClient } from "../src/backlog/client.js";
import type { BacklogIssue, BacklogStatus } from "../src/backlog/types.js";
import type { IIssueTracker, TrackedIssue } from "../src/tracker/types.js";

const standardStatuses: BacklogStatus[] = [
  { id: 1, projectId: 10, name: "未対応", color: "#ed8077", displayOrder: 1 },
  { id: 2, projectId: 10, name: "処理中", color: "#4488c5", displayOrder: 2 },
  { id: 3, projectId: 10, name: "処理済み", color: "#5eb5a6", displayOrder: 3 },
  { id: 4, projectId: 10, name: "完了", color: "#b0be3c", displayOrder: 4 },
];

function makeRawIssue(key: string, status: BacklogStatus, summary: string): BacklogIssue {
  return {
    id: 1,
    projectId: 10,
    issueKey: key,
    keyId: 1,
    issueType: { id: 1, name: "タスク" },
    summary,
    description: "",
    status,
    createdUser: { id: 1, name: "User" },
    created: "2026-09-01T00:00:00Z",
    updated: "2026-09-12T00:00:00Z",
  };
}

function makeBacklogTracker(raw: BacklogIssue): BacklogTracker {
  const client = {
    getProject: async () => ({ id: 10, projectKey: "STUDY", name: "p" }),
    getProjectStatuses: async () => standardStatuses,
    getIssues: async () => [raw],
    getIssue: async () => raw,
  } as unknown as BacklogClient;
  const tracker = new BacklogTracker({ client, projectKey: "STUDY" });
  tracker.setProjectStatuses(standardStatuses);
  return tracker;
}

describe("ResourceCleaner 安全性 (処理済み保護 / PR 状態不明保護 / Docker スイープの範囲限定)", () => {
  let tempDir: string;
  let worktreesDir: string;

  beforeEach(() => {
    runCommandMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-cleaner-safety-"));
    worktreesDir = path.join(tempDir, "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeWorktreeManager(issueKey: string, removed: string[]): GitWorktreeManager {
    const issueDir = path.join(worktreesDir, issueKey);
    fs.mkdirSync(path.join(issueDir, "my-app"), { recursive: true });
    return {
      getWorktreesDir: () => worktreesDir,
      getReposDir: () => path.join(tempDir, "repos"),
      listIssueKeysWithWorktrees: () => [issueKey],
      getIssueWorktreeDirs: () => [
        { repoName: "my-app", worktreeDir: path.join(issueDir, "my-app"), repoPath: path.join(tempDir, "repos", "my-app") },
      ],
      removeIssueWorktrees: async (k: string) => {
        removed.push(k);
      },
    } as unknown as GitWorktreeManager;
  }

  function makeGitHub(state: PullRequestState): IGitHubService {
    return {
      getPullRequestState: async () => state,
      ensurePullRequest: async () => null,
      ensurePullRequests: async () => [],
    };
  }

  it("BacklogTracker 経由で「処理済み」(lifecycle: completed) のチケットは PR が MERGED でも削除しないこと", async () => {
    runCommandMock.mockResolvedValue({ stdout: "", stderr: "" }); // docker ps → 空
    const removed: string[] = [];
    const tracker = makeBacklogTracker(
      makeRawIssue("STUDY-20", standardStatuses[2], "[要件レビュー完了] レビュー待ちタスク")
    );
    const tracked = await tracker.getIssue("STUDY-20", BUILTIN_DEFAULT_WORKFLOW);
    expect(tracked.lifecycleState).toBe("completed");

    const cleaner = new ResourceCleaner(tracker, makeWorktreeManager("STUDY-20", removed), makeGitHub("MERGED"));
    const summary = await cleaner.cleanupCompletedIssues();

    expect(summary.cleanedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(removed).toEqual([]);
  });

  it("「完了」(lifecycle: closed) かつ PR が NOT_FOUND (調査タスク等) のチケットは削除されること", async () => {
    runCommandMock.mockResolvedValue({ stdout: "", stderr: "" });
    const removed: string[] = [];
    const tracker = makeBacklogTracker(makeRawIssue("STUDY-21", standardStatuses[3], "調査タスク"));
    const tracked = await tracker.getIssue("STUDY-21", BUILTIN_DEFAULT_WORKFLOW);
    expect(tracked.lifecycleState).toBe("closed");

    const cleaner = new ResourceCleaner(tracker, makeWorktreeManager("STUDY-21", removed), makeGitHub("NOT_FOUND"));
    const summary = await cleaner.cleanupCompletedIssues();

    expect(summary.cleanedCount).toBe(1);
    expect(removed).toEqual(["STUDY-21"]);
  });

  it("「完了」でも PR 状態が UNKNOWN (gh 失敗等) の場合は判断不能として保護すること", async () => {
    runCommandMock.mockResolvedValue({ stdout: "", stderr: "" });
    const removed: string[] = [];
    const tracker = makeBacklogTracker(makeRawIssue("STUDY-22", standardStatuses[3], "完了タスク"));

    const cleaner = new ResourceCleaner(tracker, makeWorktreeManager("STUDY-22", removed), makeGitHub("UNKNOWN"));
    const summary = await cleaner.cleanupCompletedIssues();

    expect(summary.cleanedCount).toBe(0);
    expect(removed).toEqual([]);
  });

  it("DRY_RUN では削除・停止コマンドを一切実行しないこと", async () => {
    runCommandMock.mockResolvedValue({ stdout: "", stderr: "" });
    const removed: string[] = [];
    const tracker = makeBacklogTracker(makeRawIssue("STUDY-23", standardStatuses[3], "完了タスク"));

    const cleaner = new ResourceCleaner(tracker, makeWorktreeManager("STUDY-23", removed), makeGitHub("MERGED"), undefined, { dryRun: true });
    const summary = await cleaner.cleanupCompletedIssues();

    expect(summary.cleanedCount).toBe(0);
    expect(removed).toEqual([]);
    const downCalls = runCommandMock.mock.calls.filter((c) => (c[1] as string[]).includes("down"));
    expect(downCalls.length).toBe(0);
  });

  it("孤児 Docker スイープは自分の worktrees 配下のみ対象とし、照会失敗時は保護すること", async () => {
    const ownClosedDir = path.join(worktreesDir, "STUDY-30", "app");
    const ownUnknownDir = path.join(worktreesDir, "STUDY-31", "app");
    fs.mkdirSync(ownClosedDir, { recursive: true });
    fs.mkdirSync(ownUnknownDir, { recursive: true });
    const foreignDir = path.join(tempDir, "someone-else", "worktrees", "OTHER-1", "app");
    fs.mkdirSync(foreignDir, { recursive: true });

    runCommandMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === "docker" && args[0] === "ps") {
        return {
          stdout: [
            `aaa\town-closed\t${ownClosedDir}`,
            `bbb\town-unknown\t${ownUnknownDir}`,
            `ccc\tforeign-stack\t${foreignDir}`,
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const tracker: IIssueTracker = {
      trackerType: "test",
      init: async () => {},
      fetchActionableIssues: async () => [],
      fetchCompletedIssues: async () => [],
      getIssue: async (key: string): Promise<TrackedIssue> => {
        if (key === "STUDY-30") {
          return {
            key, title: "t", rawTitle: "t", description: "", lifecycleState: "closed",
            rawStatusName: "完了", recentComments: [], isInvestigation: false, isFastMode: false, updatedAt: "",
          };
        }
        throw new Error("Backlog API Error [404]");
      },
      updateIssueStep: async () => {},
      updateLifecycle: async () => {},
      addComment: async () => {},
    };

    const wm = {
      getWorktreesDir: () => worktreesDir,
      listIssueKeysWithWorktrees: () => [],
    } as unknown as GitWorktreeManager;

    const cleaner = new ResourceCleaner(tracker, wm, makeGitHub("MERGED"));
    const stopped = await cleaner.cleanOrphanDockerContainers();

    expect(stopped).toEqual(["own-closed"]);
    const downTargets = runCommandMock.mock.calls
      .filter((c) => c[0] === "docker" && (c[1] as string[])[0] === "compose")
      .map((c) => (c[1] as string[])[2]);
    expect(downTargets).toEqual(["own-closed"]);
  });
});
