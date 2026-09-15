import fs from "fs";
import path from "path";
import YAML from "yaml";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRule,
  DecisionKeyword,
} from "./types.js";

export interface WorkflowResolveOptions {
  workflowsDir?: string;
  projectKey?: string;
  isFastMode?: boolean;
  isInvestigation?: boolean;
  customYamlPath?: string;
}

export interface PromptResolveOptions {
  workflowsDir?: string;
  projectKey?: string;
  mode?: "default" | "fast" | "research";
}

/**
 * ワークフローディレクトリのデフォルトパスを取得
 */
export function getDefaultWorkflowsDir(): string {
  if (process.env.AIDEVFLOW_WORKFLOWS_DIR) {
    return process.env.AIDEVFLOW_WORKFLOWS_DIR;
  }
  return path.resolve(process.cwd(), "workflows");
}

/**
 * ビルトインのデフォルト定義（ファイルが存在しない場合の完全フォールバック）
 */
export const BUILTIN_DEFAULT_WORKFLOW: WorkflowDefinition = {
  name: "default",
  description: "5役多段SOP標準開発パイプライン",
  initial_step: "spec-writer",
  max_steps: 20,
  steps: {
    "spec-writer": {
      name: "spec-writer",
      role: "spec-writer",
      title: "詳細仕様策定",
      tracker_tag: "[詳細設計中]",
      step_tag: "[詳細設計中]",
      backlog_tag: "[詳細設計中]",
      status_name: "詳細設計",
      custom_status: "詳細設計",
      edit: true,
      rules: [
        { if: "PLANNED", goto: "spec-reviewer" },
        { if: "HUMAN_REQUIRED", goto: "spec-writer", human_escalation: true },
        { goto: "spec-reviewer" },
      ],
    },
    "spec-reviewer": {
      name: "spec-reviewer",
      role: "spec-reviewer",
      title: "詳細仕様レビュー",
      tracker_tag: "[設計レビュー中]",
      step_tag: "[設計レビュー中]",
      backlog_tag: "[設計レビュー中]",
      status_name: "設計レビュー",
      custom_status: "設計レビュー",
      edit: false,
      rules: [
        { if: "APPROVED", goto: "developer", human_gate: true },
        { if: "REJECTED", goto: "spec-writer" },
        { if: "HUMAN_REQUIRED", goto: "spec-reviewer", human_escalation: true },
        { goto: "developer" },
      ],
    },
    "developer": {
      name: "developer",
      role: "developer",
      title: "コード実装・テスト・PR作成",
      tracker_tag: "[実装中]",
      step_tag: "[実装中]",
      backlog_tag: "[実装中]",
      status_name: "実装",
      custom_status: "実装",
      edit: true,
      rules: [
        { if: "IMPLEMENTED", goto: "code-reviewer" },
        { if: "HUMAN_REQUIRED", goto: "developer", human_escalation: true },
        { goto: "code-reviewer" },
      ],
    },
    "code-reviewer": {
      name: "code-reviewer",
      role: "code-reviewer",
      title: "技術観点レビュー",
      tracker_tag: "[技術レビュー中]",
      step_tag: "[技術レビュー中]",
      backlog_tag: "[技術レビュー中]",
      status_name: "技術レビュー",
      custom_status: "技術レビュー",
      edit: false,
      rules: [
        { if: "APPROVED", goto: "requirement-reviewer" },
        { if: "REJECTED", goto: "developer" },
        { if: "HUMAN_REQUIRED", goto: "code-reviewer", human_escalation: true },
        { goto: "requirement-reviewer" },
      ],
    },
    "requirement-reviewer": {
      name: "requirement-reviewer",
      role: "requirement-reviewer",
      title: "要件充足度レビュー",
      tracker_tag: "[要件レビュー中]",
      step_tag: "[要件レビュー中]",
      backlog_tag: "[要件レビュー中]",
      status_name: "要件レビュー",
      custom_status: "要件レビュー",
      edit: false,
      rules: [
        { if: "APPROVED", goto: "COMPLETE" },
        { if: "REJECTED", goto: "developer" },
        { if: "HUMAN_REQUIRED", goto: "requirement-reviewer", human_escalation: true },
        { goto: "COMPLETE" },
      ],
    },
  },
};

/**
 * チケットの条件に基づき、適用すべき workflow.yaml のファイルパスを解決する
 */
export function resolveWorkflowPath(options: WorkflowResolveOptions): string {
  const workflowsDir = options.workflowsDir || getDefaultWorkflowsDir();

  if (options.customYamlPath && fs.existsSync(options.customYamlPath)) {
    return options.customYamlPath;
  }

  if (options.isFastMode) {
    const fastPath = path.join(workflowsDir, "fast", "workflow.yaml");
    if (fs.existsSync(fastPath)) return fastPath;
  }

  if (options.isInvestigation) {
    const researchPath = path.join(workflowsDir, "research", "workflow.yaml");
    if (fs.existsSync(researchPath)) return researchPath;
  }

  if (options.projectKey) {
    const projectPath = path.join(workflowsDir, options.projectKey, "workflow.yaml");
    if (fs.existsSync(projectPath)) return projectPath;
  }

  return path.join(workflowsDir, "default", "workflow.yaml");
}

/**
 * YAML ファイルまたは解決オプションからワークフロー定義をロードする
 */
export function loadWorkflow(input: string | WorkflowResolveOptions): WorkflowDefinition {
  let targetPath: string;

  if (typeof input === "string") {
    targetPath = input;
  } else {
    targetPath = resolveWorkflowPath(input);
  }

  if (!fs.existsSync(targetPath)) {
    // ファイルが存在しない場合はビルトイン定義をフォールバックとして返す
    console.warn(`[WorkflowLoader] ワークフローファイルが見つかりません: ${targetPath}。ビルトインデフォルトを使用します。`);
    return BUILTIN_DEFAULT_WORKFLOW;
  }

  try {
    const content = fs.readFileSync(targetPath, "utf-8");
    const raw: unknown = YAML.parse(content);
    return validateAndNormalizeWorkflow(raw, targetPath);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WorkflowLoader] ワークフローYAMLパースエラー (${targetPath}):`, err);
    throw new Error(`ワークフロー定義の読み込みに失敗しました (${targetPath}): ${errMsg}`);
  }
}

/**
 * 読み込んだオブジェクトの検証と正規化
 */
export function validateAndNormalizeWorkflow(raw: unknown, sourcePath?: string): WorkflowDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`無効なワークフロー形式です: ${sourcePath || "unknown"}`);
  }

  const rawObj = raw as Record<string, unknown>;

  if (!rawObj.name || typeof rawObj.name !== "string") {
    throw new Error(`ワークフローの name が指定されていません: ${sourcePath}`);
  }

  if (!rawObj.steps || typeof rawObj.steps !== "object") {
    throw new Error(`ワークフローの steps が定義されていません: ${sourcePath}`);
  }

  const rawSteps = rawObj.steps as Record<string, unknown>;
  const initialStep = (typeof rawObj.initial_step === "string" ? rawObj.initial_step : "") || Object.keys(rawSteps)[0];
  if (!rawSteps[initialStep]) {
    throw new Error(`初期ステップ initial_step "${initialStep}" が steps 内に見つかりません: ${sourcePath}`);
  }

  const normalizedSteps: Record<string, WorkflowStep> = {};

  for (const [stepKey, stepValRaw] of Object.entries(rawSteps)) {
    if (!stepValRaw || typeof stepValRaw !== "object") {
      throw new Error(`ステップ "${stepKey}" の定義が無効です: ${sourcePath}`);
    }
    const stepVal = stepValRaw as Record<string, unknown>;

    const rules: WorkflowRule[] = Array.isArray(stepVal.rules)
      ? stepVal.rules.map((r: unknown) => {
          const ruleObj = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
          return {
            if: typeof ruleObj.if === "string" ? (ruleObj.if as DecisionKeyword) : undefined,
            goto: typeof ruleObj.goto === "string" ? ruleObj.goto : "",
            human_gate: Boolean(ruleObj.human_gate),
            human_escalation: Boolean(ruleObj.human_escalation),
          };
        })
      : [];

    const trackerTag =
      (typeof stepVal.tracker_tag === "string" ? stepVal.tracker_tag : undefined) ||
      (typeof stepVal.step_tag === "string" ? stepVal.step_tag : undefined) ||
      (typeof stepVal.backlog_tag === "string" ? stepVal.backlog_tag : undefined) ||
      `[${stepKey}]`;
    const statusName =
      (typeof stepVal.status_name === "string" ? stepVal.status_name : undefined) ||
      (typeof stepVal.custom_status === "string" ? stepVal.custom_status : undefined) ||
      stepKey;

    normalizedSteps[stepKey] = {
      name: stepKey,
      role: typeof stepVal.role === "string" ? stepVal.role : stepKey,
      title: typeof stepVal.title === "string" ? stepVal.title : stepKey,
      tracker_tag: trackerTag,
      step_tag: trackerTag,
      backlog_tag: trackerTag,
      status_name: statusName,
      custom_status: statusName,
      edit: typeof stepVal.edit === "boolean" ? stepVal.edit : true,
      model: typeof stepVal.model === "string" ? stepVal.model : undefined,
      effort: typeof stepVal.effort === "string" ? (stepVal.effort as WorkflowStep["effort"]) : undefined,
      instruction: typeof stepVal.instruction === "string" ? stepVal.instruction : undefined,
      rules,
    };
  }

  return {
    name: rawObj.name,
    description: typeof rawObj.description === "string" ? rawObj.description : undefined,
    initial_step: initialStep,
    max_steps: typeof rawObj.max_steps === "number" ? rawObj.max_steps : 20,
    steps: normalizedSteps,
  };
}

/**
 * ステップに対応するプロンプト本文（Markdown）を探索・解決する
 */
export function resolveStepPrompt(
  stepName: string,
  step: WorkflowStep,
  options: PromptResolveOptions = {}
): string {
  const workflowsDir = options.workflowsDir || getDefaultWorkflowsDir();

  // 1. step.instruction の明示指定
  if (step.instruction) {
    const explicitPath = path.isAbsolute(step.instruction)
      ? step.instruction
      : path.resolve(workflowsDir, step.instruction);
    if (fs.existsSync(explicitPath)) {
      return fs.readFileSync(explicitPath, "utf-8").trim();
    }
  }

  // 2. プロジェクト固有プロンプト: workflows/<PROJECT_KEY>/prompts/<stepName>.md
  if (options.projectKey) {
    const projectPromptPath = path.join(workflowsDir, options.projectKey, "prompts", `${stepName}.md`);
    if (fs.existsSync(projectPromptPath)) {
      return fs.readFileSync(projectPromptPath, "utf-8").trim();
    }
  }

  // 3. モード別プロンプト: workflows/<mode>/prompts/<stepName>.md (例: fast/prompts/code-reviewer.md)
  if (options.mode && options.mode !== "default") {
    const modePromptPath = path.join(workflowsDir, options.mode, "prompts", `${stepName}.md`);
    if (fs.existsSync(modePromptPath)) {
      return fs.readFileSync(modePromptPath, "utf-8").trim();
    }
  }

  // 4. デフォルトプロンプト: workflows/default/prompts/<stepName>.md
  const defaultPromptPath = path.join(workflowsDir, "default", "prompts", `${stepName}.md`);
  if (fs.existsSync(defaultPromptPath)) {
    return fs.readFileSync(defaultPromptPath, "utf-8").trim();
  }

  if (stepName === step.role) {
    const rolePromptPath = path.join(workflowsDir, "default", "prompts", `${step.role}.md`);
    if (fs.existsSync(rolePromptPath)) {
      return fs.readFileSync(rolePromptPath, "utf-8").trim();
    }
  }

  // 5. 汎用ミニマルテンプレート（カスタムステップ用）
  return `
あなたは【${step.title || stepName}】担当エージェントです。
チケットの指示に従って作業を実施してください。

【決定キーワードの出力ルール（必須）】
出力の最終行に、処理結果に応じた決定トークンを必ず HTML コメント形式で単独行に出力してください:
- 完了時: <!-- DECISION: APPROVED -->
- 差し戻し時: <!-- DECISION: REJECTED -->
- 人間の確認が必要な時: <!-- DECISION: HUMAN_REQUIRED -->
`.trim();
}
