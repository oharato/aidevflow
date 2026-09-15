import { describe, it, expect, beforeEach } from "vitest";
import { MockIssueTracker } from "../../src/tracker/adapters/mock-tracker.js";
import { BUILTIN_DEFAULT_WORKFLOW } from "../../src/workflow/loader.js";
import type { WorkflowDefinition } from "../../src/workflow/types.js";

describe("MockIssueTracker", () => {
  let tracker: MockIssueTracker;

  beforeEach(() => {
    tracker = new MockIssueTracker();
  });

  it("初期チケットを登録し、getIssue で取得できること", async () => {
    tracker.addMockIssue({
      key: "TEST-1",
      title: "テストタスク",
      description: "要件テスト",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    const issue = await tracker.getIssue("TEST-1");
    expect(issue.key).toBe("TEST-1");
    expect(issue.title).toBe("テストタスク");
    expect(issue.currentStepName).toBe("spec-writer");
    expect(issue.lifecycleState).toBe("in_progress");
  });

  it("fetchActionableIssues で進行中かつ定義されたステップのみ取得できること", async () => {
    // 1. 進行中 (対象)
    tracker.addMockIssue({
      key: "TEST-1",
      title: "タスク1",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });
    // 2. 未対応 (対象外)
    tracker.addMockIssue({
      key: "TEST-2",
      title: "タスク2",
      lifecycleState: "ready",
    });
    // 3. 確認待ち (対象外)
    tracker.addMockIssue({
      key: "TEST-3",
      title: "タスク3",
      currentStepName: "developer",
      lifecycleState: "waiting_confirmation",
    });

    const actionable = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW);
    expect(actionable.length).toBe(1);
    expect(actionable[0].key).toBe("TEST-1");
  });

  it("onlyAssignedToMe で自分が担当のチケットのみ取得できること", async () => {
    tracker.setCurrentUser({ id: 7, name: "me" });
    tracker.addMockIssue({
      key: "TEST-1",
      title: "自分のタスク",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
      assigneeId: 7,
    });
    tracker.addMockIssue({
      key: "TEST-2",
      title: "他人のタスク",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
      assigneeId: 8,
    });
    tracker.addMockIssue({
      key: "TEST-3",
      title: "未割り当てのタスク",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    const mine = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW, {
      onlyAssignedToMe: true,
    });
    expect(mine.map((i) => i.key)).toEqual(["TEST-1"]);

    const all = await tracker.fetchActionableIssues(BUILTIN_DEFAULT_WORKFLOW);
    expect(all.length).toBe(3);
  });

  it("updateIssueStep で次ステップへの遷移とコメントが記録されること", async () => {
    tracker.addMockIssue({
      key: "TEST-1",
      title: "機能開発",
      currentStepName: "spec-writer",
      lifecycleState: "in_progress",
    });

    const nextStep = BUILTIN_DEFAULT_WORKFLOW.steps["spec-reviewer"];
    await tracker.updateIssueStep("TEST-1", nextStep, {
      comment: "仕様策定が完了しました",
    });

    const updated = await tracker.getIssue("TEST-1");
    expect(updated.currentStepName).toBe("spec-reviewer");
    expect(updated.lifecycleState).toBe("in_progress");
    expect(updated.rawTitle).toContain("[設計レビュー中]");

    const comments = tracker.getPostedComments("TEST-1");
    expect(comments).toContain("仕様策定が完了しました");
    expect(tracker.stepTransitions.length).toBe(1);
    expect(tracker.stepTransitions[0].nextStep.name).toBe("spec-reviewer");
  });

  it("updateLifecycle で確認待ち・承認待ち・完了状態に遷移できること", async () => {
    tracker.addMockIssue({
      key: "TEST-1",
      title: "機能開発",
      currentStepName: "developer",
      lifecycleState: "in_progress",
    });

    // 確認待ちへ
    await tracker.updateLifecycle("TEST-1", "waiting_confirmation", {
      comment: "質問があります",
    });
    let issue = await tracker.getIssue("TEST-1");
    expect(issue.lifecycleState).toBe("waiting_confirmation");
    expect(issue.rawStatusName).toBe("未対応");

    // 完了へ
    await tracker.updateLifecycle("TEST-1", "completed", {
      comment: "全工程完了",
    });
    issue = await tracker.getIssue("TEST-1");
    expect(issue.lifecycleState).toBe("completed");

    const completed = await tracker.fetchCompletedIssues();
    expect(completed.length).toBe(1);
    expect(completed[0].key).toBe("TEST-1");
  });

  it("ユーザー定義のカスタムステップでも動的に機能すること", async () => {
    const customWorkflow: WorkflowDefinition = {
      name: "custom-pipeline",
      initial_step: "architect",
      steps: {
        architect: {
          name: "architect",
          role: "architect",
          title: "アーキテクチャ設計",
          backlog_tag: "[設計中]",
          custom_status: "設計",
          edit: true,
          rules: [{ if: "APPROVED", goto: "coder" }],
        },
        coder: {
          name: "coder",
          role: "coder",
          title: "実装",
          backlog_tag: "[実装中]",
          custom_status: "実装",
          edit: true,
          rules: [{ if: "APPROVED", goto: "COMPLETE" }],
        },
      },
    };

    tracker.addMockIssue({
      key: "CUSTOM-1",
      title: "新規マイクロサービス",
      currentStepName: "architect",
      lifecycleState: "in_progress",
    });

    const actionable = await tracker.fetchActionableIssues(customWorkflow);
    expect(actionable.length).toBe(1);
    expect(actionable[0].currentStepName).toBe("architect");

    await tracker.updateIssueStep("CUSTOM-1", customWorkflow.steps["coder"]);
    const updated = await tracker.getIssue("CUSTOM-1");
    expect(updated.currentStepName).toBe("coder");
    expect(updated.rawTitle).toContain("[実装中]");
  });
});
