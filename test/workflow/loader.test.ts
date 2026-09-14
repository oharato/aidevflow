import { describe, it, expect } from "vitest";
import path from "path";
import {
  loadWorkflow,
  resolveWorkflowPath,
  resolveStepPrompt,
  BUILTIN_DEFAULT_WORKFLOW,
} from "../../src/workflow/loader.js";

describe("WorkflowLoader", () => {
  it("workflows/default/workflow.yaml が正常にロードされ 5役ステップが含まれること", () => {
    const wf = loadWorkflow({
      workflowsDir: path.resolve(process.cwd(), "workflows"),
    });

    expect(wf.name).toBe("default");
    expect(wf.initial_step).toBe("spec-writer");
    expect(Object.keys(wf.steps)).toEqual([
      "spec-writer",
      "spec-reviewer",
      "developer",
      "code-reviewer",
      "requirement-reviewer",
    ]);

    // 権限制御の確認
    expect(wf.steps["spec-writer"].edit).toBe(true);
    expect(wf.steps["spec-reviewer"].edit).toBe(false);
    expect(wf.steps["developer"].edit).toBe(true);
    expect(wf.steps["code-reviewer"].edit).toBe(false);
    expect(wf.steps["requirement-reviewer"].edit).toBe(false);

    // ルールの確認
    expect(wf.steps["spec-reviewer"].rules.some((r) => r.human_gate)).toBe(true);
  });

  it("Fastモードの workflow.yaml が正常にロードされ 2段階ステップであること", () => {
    const wf = loadWorkflow({
      workflowsDir: path.resolve(process.cwd(), "workflows"),
      isFastMode: true,
    });

    expect(wf.name).toBe("fast");
    expect(wf.initial_step).toBe("developer");
    expect(Object.keys(wf.steps)).toEqual(["developer", "code-reviewer"]);
    expect(wf.steps["developer"].edit).toBe(true);
    expect(wf.steps["code-reviewer"].edit).toBe(false);
  });

  it("Researchモードの workflow.yaml が正常にロードされ spec -> review であること", () => {
    const wf = loadWorkflow({
      workflowsDir: path.resolve(process.cwd(), "workflows"),
      isInvestigation: true,
    });

    expect(wf.name).toBe("research");
    expect(wf.initial_step).toBe("spec-writer");
    expect(Object.keys(wf.steps)).toEqual(["spec-writer", "spec-reviewer"]);
  });

  it("存在しないパスを指定した場合は警告を出しつつビルトインデフォルト定義を返すこと", () => {
    const wf = loadWorkflow({
      workflowsDir: "/non/existent/dir",
    });

    expect(wf.name).toBe("default");
    expect(wf.initial_step).toBe("spec-writer");
    expect(wf.steps["developer"]).toBeDefined();
  });

  describe("resolveWorkflowPath", () => {
    it("isFastMode 時は fast を優先すること", () => {
      const p = resolveWorkflowPath({ isFastMode: true });
      expect(p).toContain("fast/workflow.yaml");
    });

    it("isInvestigation 時は research を優先すること", () => {
      const p = resolveWorkflowPath({ isInvestigation: true });
      expect(p).toContain("research/workflow.yaml");
    });

    it("通常時は default を返すこと", () => {
      const p = resolveWorkflowPath({});
      expect(p).toContain("default/workflow.yaml");
    });
  });

  describe("resolveStepPrompt", () => {
    it("default/prompts/<step>.md が存在する場合はその内容を読み込むこと", () => {
      const step = BUILTIN_DEFAULT_WORKFLOW.steps["spec-writer"];
      const prompt = resolveStepPrompt("spec-writer", step);

      expect(prompt).toContain("あなたは【spec-writer（詳細仕様策定エージェント）】です。");
      expect(prompt).toContain("<!-- DECISION: PLANNED -->");
    });

    it("未知のカスタムステップの場合は汎用ミニマルテンプレートを生成すること", () => {
      const customStep = {
        name: "security-audit",
        role: "code-reviewer" as const,
        title: "セキュリティ監査",
        backlog_tag: "[セキュリティ監査中]",
        custom_status: "セキュリティ監査",
        edit: false,
        rules: [],
      };

      const prompt = resolveStepPrompt("security-audit", customStep);
      expect(prompt).toContain("あなたは【セキュリティ監査】担当エージェントです。");
      expect(prompt).toContain("<!-- DECISION: APPROVED -->");
    });
  });
});
