import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { BUILTIN_DEFAULT_WORKFLOW } from "../../src/workflow/loader.js";

describe("WorkflowEngine 状態遷移マシン", () => {
  it("標準 5役SOP の正常系リレー（仕様策定 -> 設計レビュー -> 実装 -> 技術レビュー -> 要件レビュー -> 完了）が完走すること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW);

    // 1. spec-writer
    expect(engine.getCurrentStepName()).toBe("spec-writer");
    expect(engine.getCurrentStep().edit).toBe(true);
    const res1 = engine.evaluateNextStep("PLANNED");
    expect(res1.nextStepName).toBe("spec-reviewer");
    expect(res1.isRejection).toBe(false);
    expect(res1.targetBacklogTag).toBe("[設計レビュー中]");
    engine.transition(res1.nextStepName);

    // 2. spec-reviewer (human_gate なし)
    expect(engine.getCurrentStepName()).toBe("spec-reviewer");
    expect(engine.getCurrentStep().edit).toBe(false);
    const res2 = engine.evaluateNextStep("APPROVED", { requireHumanSpecApproval: false });
    expect(res2.nextStepName).toBe("developer");
    expect(res2.isHumanGate).toBe(false);
    expect(res2.targetBacklogTag).toBe("[実装中]");
    engine.transition(res2.nextStepName);

    // 3. developer
    expect(engine.getCurrentStepName()).toBe("developer");
    expect(engine.getCurrentStep().edit).toBe(true);
    const res3 = engine.evaluateNextStep("IMPLEMENTED");
    expect(res3.nextStepName).toBe("code-reviewer");
    expect(res3.targetBacklogTag).toBe("[技術レビュー中]");
    engine.transition(res3.nextStepName);

    // 4. code-reviewer
    expect(engine.getCurrentStepName()).toBe("code-reviewer");
    expect(engine.getCurrentStep().edit).toBe(false);
    const res4 = engine.evaluateNextStep("APPROVED");
    expect(res4.nextStepName).toBe("requirement-reviewer");
    expect(res4.targetBacklogTag).toBe("[要件レビュー中]");
    engine.transition(res4.nextStepName);

    // 5. requirement-reviewer
    expect(engine.getCurrentStepName()).toBe("requirement-reviewer");
    expect(engine.getCurrentStep().edit).toBe(false);
    const res5 = engine.evaluateNextStep("APPROVED");
    expect(res5.nextStepName).toBe("COMPLETE");
    expect(res5.targetBacklogTag).toBe("[完了]");
    engine.transition(res5.nextStepName);

    expect(engine.isFinished()).toBe(true);
    expect(engine.isAborted()).toBe(false);
    expect(engine.getExecutionHistory().length).toBe(5);
  });

  it("requireHumanSpecApproval が true のとき、spec-reviewer 承認で human_gate が検知されること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW, "spec-reviewer");
    const result = engine.evaluateNextStep("APPROVED", { requireHumanSpecApproval: true });

    expect(result.nextStepName).toBe("developer");
    expect(result.isHumanGate).toBe(true);
  });

  it("code-reviewer で REJECTED の場合、developer に差し戻されること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW, "code-reviewer");
    const result = engine.evaluateNextStep("REJECTED");

    expect(result.nextStepName).toBe("developer");
    expect(result.isRejection).toBe(true);
    expect(result.targetBacklogTag).toBe("[実装中]");
    expect(result.targetCustomStatus).toBe("実装");
  });

  it("requirement-reviewer で REJECTED の場合、developer に差し戻されること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW, "requirement-reviewer");
    const result = engine.evaluateNextStep("REJECTED");

    expect(result.nextStepName).toBe("developer");
    expect(result.isRejection).toBe(true);
    expect(result.targetBacklogTag).toBe("[実装中]");
  });

  it("spec-reviewer で REJECTED の場合、spec-writer に差し戻されること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW, "spec-reviewer");
    const result = engine.evaluateNextStep("REJECTED");

    expect(result.nextStepName).toBe("spec-writer");
    expect(result.isRejection).toBe(true);
    expect(result.targetBacklogTag).toBe("[詳細設計中]");
  });

  it("HUMAN_REQUIRED の場合、isEscalation が true となりそのステップに留まること", () => {
    const engine = new WorkflowEngine(BUILTIN_DEFAULT_WORKFLOW, "developer");
    const result = engine.evaluateNextStep("HUMAN_REQUIRED");

    expect(result.nextStepName).toBe("developer");
    expect(result.isEscalation).toBe(true);
    expect(result.isRejection).toBe(false);
  });

  it("max_steps を超過した場合、自動で ABORT され無限ループを防止すること", () => {
    const customWf = {
      ...BUILTIN_DEFAULT_WORKFLOW,
      max_steps: 3,
    };
    const engine = new WorkflowEngine(customWf);

    engine.evaluateNextStep("PLANNED"); // 1
    engine.evaluateNextStep("REJECTED"); // 2
    engine.evaluateNextStep("PLANNED"); // 3
    const res4 = engine.evaluateNextStep("REJECTED"); // 4 (超過)

    expect(res4.nextStepName).toBe("ABORT");
    expect(res4.isEscalation).toBe(true);
    expect(engine.isAborted()).toBe(true);
  });
});
