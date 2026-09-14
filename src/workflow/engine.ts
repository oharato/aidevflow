import type {
  DecisionKeyword,
  StepEvaluationResult,
  WorkflowDefinition,
  WorkflowStep,
} from "./types.js";

export interface WorkflowEngineOptions {
  requireHumanSpecApproval?: boolean;
}

/**
 * 宣言的ワークフローエンジン
 * ワークフロー定義（WorkflowDefinition）に基づき、
 * 現在のステップ管理、決定キーワードによる遷移ルール評価、最大ステップ数超過制御を行う。
 */
export class WorkflowEngine {
  private definition: WorkflowDefinition;
  private currentStepName: string;
  private stepCount: number = 0;
  private isFinishedState: boolean = false;
  private isAbortedState: boolean = false;
  private executionHistory: Array<{
    stepName: string;
    decision: DecisionKeyword;
    nextStepName: string;
    timestamp: Date;
  }> = [];

  constructor(definition: WorkflowDefinition, startStepName?: string) {
    this.definition = definition;
    const initial = startStepName || definition.initial_step;
    if (!definition.steps[initial]) {
      throw new Error(
        `ワークフロー "${definition.name}" に初期ステップ "${initial}" が存在しません`
      );
    }
    this.currentStepName = initial;
  }

  getDefinition(): WorkflowDefinition {
    return this.definition;
  }

  getCurrentStepName(): string {
    return this.currentStepName;
  }

  getCurrentStep(): WorkflowStep {
    const step = this.definition.steps[this.currentStepName];
    if (!step) {
      throw new Error(`現在のステップ "${this.currentStepName}" が定義に見つかりません`);
    }
    return step;
  }

  getStepByName(stepName: string): WorkflowStep | undefined {
    return this.definition.steps[stepName];
  }

  getStepCount(): number {
    return this.stepCount;
  }

  isFinished(): boolean {
    return this.isFinishedState;
  }

  isAborted(): boolean {
    return this.isAbortedState;
  }

  getExecutionHistory() {
    return [...this.executionHistory];
  }

  /**
   * 現在のステップと決定キーワードに基づき、次のステップへの遷移を評価する
   */
  evaluateNextStep(
    decision: DecisionKeyword,
    options: WorkflowEngineOptions = {}
  ): StepEvaluationResult {
    const currentStep = this.getCurrentStep();
    const maxSteps = this.definition.max_steps || 20;

    this.stepCount++;
    if (this.stepCount > maxSteps) {
      console.warn(
        `[WorkflowEngine] ⚠️ 最大ステップ数 (${maxSteps}) を超過しました。無限ループ防止のため中止します。`
      );
      this.isAbortedState = true;
      return {
        nextStepName: "ABORT",
        decision,
        isRejection: decision === "REJECTED",
        isEscalation: true,
        isHumanGate: false,
        targetBacklogTag: "[確認待ち]",
        targetCustomStatus: "確認待ち",
      };
    }

    let matchedRule = currentStep.rules.find((r) => r.if === decision);
    if (!matchedRule) {
      // if が指定されていない無条件フォールバックルールを検索
      matchedRule = currentStep.rules.find((r) => !r.if);
    }

    if (!matchedRule) {
      // ルールが全く定義されていない場合のデフォルトフォールバック
      matchedRule = {
        goto: decision === "APPROVED" ? "COMPLETE" : currentStep.name,
      };
    }

    const nextStepName = matchedRule.goto;
    const isHumanGate = Boolean(
      matchedRule.human_gate && options.requireHumanSpecApproval
    );
    const isEscalation = Boolean(
      decision === "HUMAN_REQUIRED" || matchedRule.human_escalation
    );
    const isRejection = decision === "REJECTED";

    let targetBacklogTag: string;
    let targetCustomStatus: string;

    if (nextStepName === "COMPLETE") {
      targetBacklogTag = "[完了]";
      targetCustomStatus = "完了";
    } else if (nextStepName === "ABORT") {
      targetBacklogTag = "[確認待ち]";
      targetCustomStatus = "確認待ち";
    } else {
      const nextStep = this.definition.steps[nextStepName];
      targetBacklogTag = nextStep?.backlog_tag || `[${nextStepName}]`;
      targetCustomStatus = nextStep?.custom_status || nextStepName;
    }

    this.executionHistory.push({
      stepName: currentStep.name,
      decision,
      nextStepName,
      timestamp: new Date(),
    });

    return {
      nextStepName,
      decision,
      isRejection,
      isEscalation,
      isHumanGate,
      targetBacklogTag,
      targetCustomStatus,
    };
  }

  /**
   * 評価結果に基づき、エンジン内部の状態を次ステップに進める
   */
  transition(nextStepName: string | "COMPLETE" | "ABORT"): void {
    if (nextStepName === "COMPLETE") {
      this.isFinishedState = true;
    } else if (nextStepName === "ABORT") {
      this.isAbortedState = true;
    } else {
      if (!this.definition.steps[nextStepName]) {
        throw new Error(
          `遷移先ステップ "${nextStepName}" がワークフロー "${this.definition.name}" に存在しません`
        );
      }
      this.currentStepName = nextStepName;
    }
  }
}
