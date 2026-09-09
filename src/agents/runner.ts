import { spawn } from "child_process";
import type { AgentRole, AgentContext, AgentResult, IAgentRunner } from "./types.js";
import { buildAgentPrompt } from "./prompts.js";

/**
 * Antigravity CLI (agy) によるエージェントランナー
 */
export class AgyRunner implements IAgentRunner {
  private workDir: string;
  private effort: "low" | "medium" | "high";

  constructor(workDir: string = process.cwd(), effort: "low" | "medium" | "high" = "medium") {
    this.workDir = workDir;
    this.effort = effort;
  }

  async run(role: AgentRole, context: AgentContext): Promise<AgentResult> {
    const prompt = buildAgentPrompt(role, context);
    console.log(`[AgyRunner] Spawning Antigravity CLI (agy) for role: ${role}...`);

    return new Promise<AgentResult>((resolve, reject) => {
      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--effort",
        this.effort,
      ];

      const child = spawn("agy", args, {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(`[agy:${role}] ${text}`);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(`[agy:ERR] ${text}`);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          console.error(`[AgyRunner] agy process exited with code ${code}`);
        }
        const isRejection =
          stdout.includes("差し戻し") ||
          stdout.includes("REJECT") ||
          stdout.includes("リジェクト");
        resolve({
          role,
          success: code === 0,
          summary: `エージェント [${role}] が実行されました (終了コード: ${code})`,
          isRejection,
          output: stdout || stderr,
        });
      });

      child.on("error", (err) => {
        console.error(`[AgyRunner] Failed to spawn agy CLI:`, err);
        reject(err);
      });
    });
  }
}

/**
 * Claude Code CLI (claude) によるエージェントランナー
 */
export class ClaudeCliRunner implements IAgentRunner {
  private workDir: string;

  constructor(workDir: string = process.cwd()) {
    this.workDir = workDir;
  }

  async run(role: AgentRole, context: AgentContext): Promise<AgentResult> {
    const prompt = buildAgentPrompt(role, context);
    console.log(`[ClaudeCliRunner] Spawning Claude Code CLI for role: ${role}...`);

    return new Promise<AgentResult>((resolve, reject) => {
      const child = spawn("claude", ["-p", prompt], {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(`[Claude:${role}] ${text}`);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(`[Claude:ERR] ${text}`);
      });

      child.on("close", (code) => {
        if (code !== 0) {
          console.error(`[ClaudeCliRunner] Claude process exited with code ${code}`);
        }
        const isRejection = stdout.includes("差し戻し") || stdout.includes("REJECT");
        resolve({
          role,
          success: code === 0,
          summary: `エージェント [${role}] が実行されました (終了コード: ${code})`,
          isRejection,
          output: stdout || stderr,
        });
      });

      child.on("error", (err) => {
        console.error(`[ClaudeCliRunner] Failed to spawn claude CLI:`, err);
        reject(err);
      });
    });
  }
}

/**
 * テスト/モック実行用ランナー
 */
export class MockRunner implements IAgentRunner {
  async run(role: AgentRole, context: AgentContext): Promise<AgentResult> {
    console.log(`[MockRunner] Simulating role: ${role} on issue: ${context.issueKey}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let output = "";
    let isRejection = false;

    switch (role) {
      case "director":
        output = `【詳細設計書作成完了】\n- 対象: ${context.issueSummary}\n- 構成案を策定しました。\n次は curator による詳細設計レビューです。`;
        break;
      case "curator":
        output = `【詳細設計レビュー完了】\n- 設計内容を確認し、問題ありませんでした（LGTM）。\n次は artist による実装です。`;
        break;
      case "artist":
        output = `【実装完了】\n- 設計書に基づいてコードとテストを実装しました。\n次は critic による技術レビューです。`;
        break;
      case "critic":
        output = `【技術レビュー完了】\n- 型安全性、テスト、規約を確認しました（LGTM）。\n次は editor による要件レビューです。`;
        break;
      case "editor":
        output = `【要件レビュー完了】\n- チケット要件との整合性を確認しました（LGTM）。全工程が完了しました。`;
        break;
    }

    return {
      role,
      success: true,
      summary: `[Mock] エージェント ${role} の処理が完了しました`,
      isRejection,
      output,
    };
  }
}
