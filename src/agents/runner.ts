import { spawn } from "child_process";
import type { AgentRole, AgentContext, AgentResult, IAgentRunner } from "./types.js";
import { buildAgentPrompt } from "./prompts.js";

/**
 * 出力テキストから差し戻し（Rejection）判定を行う。
 * 「差し戻しはありません」「差し戻し: なし」「リジェクト不要」等の否定表現による誤検知を防止する。
 */
export function checkIsRejection(outputText: string): boolean {
  if (!outputText) return false;

  const negativePatterns = [
    /(?:差し戻し|REJECT|リジェクト)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
    /(?:指摘|問題|修正)[^。\n]*?(?:差し戻し|REJECT|リジェクト)[^。\n]*?(?:なし|不要|ありません|ございません|ゼロ)/gi,
  ];

  let sanitized = outputText;
  for (const pat of negativePatterns) {
    sanitized = sanitized.replace(pat, "");
  }

  return (
    sanitized.includes("差し戻し") ||
    sanitized.includes("REJECT") ||
    sanitized.includes("リジェクト")
  );
}

/**
 * Antigravity CLI (agy) によるエージェントランナー
 */
export class AgyRunner implements IAgentRunner {
  private workDir: string;
  private effort: "low" | "medium" | "high";
  private timeout: string;
  private model?: string;
  private reviewModel?: string;

  constructor(
    workDir: string = process.cwd(),
    effort: "low" | "medium" | "high" = "low",
    timeout: string = "20m",
    model?: string,
    reviewModel?: string
  ) {
    this.workDir = workDir;
    this.effort = effort;
    this.timeout = timeout;
    this.model = model || "gemini-3.8-flash-high";
    this.reviewModel = reviewModel;
  }

  async run(role: AgentRole, context: AgentContext): Promise<AgentResult> {
    const prompt = buildAgentPrompt(role, context);
    const isReview = role === "curator" || role === "critic" || role === "editor";
    const selectedModel = (isReview && this.reviewModel) ? this.reviewModel : this.model;

    console.log(
      `[AgyRunner] Spawning Antigravity CLI (agy) for role: ${role}... (model: ${selectedModel || "default"}, effort: ${this.effort}, timeout: ${this.timeout})`
    );

    return new Promise<AgentResult>((resolve, reject) => {
      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--effort",
        this.effort,
        "--print-timeout",
        this.timeout,
        "--output-format",
        "stream-json",
      ];

      if (selectedModel) {
        args.push("--model", selectedModel);
      }

      const startTime = Date.now();
      let elapsedSeconds = 0;
      const heartbeatTimer = setInterval(() => {
        elapsedSeconds += 10;
        console.log(`[AgyRunner] ${role} エージェント実行中... (${elapsedSeconds}秒経過 / プロンプト処理・思考中)`);
      }, 10000);

      const runCwd = context.workDir || this.workDir;
      const child = spawn("agy", args, {
        cwd: runCwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // デーモン終了・停止時に agy 子プロセスを確実に道連れ終了させる安全ハンドラ
      const cleanupChild = () => {
        if (!child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      };
      process.once("SIGINT", cleanupChild);
      process.once("SIGTERM", cleanupChild);
      process.once("exit", cleanupChild);

      let rawStderr = "";
      let accumulatedText = "";
      let finalResponse = "";
      let lineBuffer = "";
      let lastToolCall = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        lineBuffer += text;

        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.event === "init") {
              console.log(`[agy:${role}] セッション開始 (ID: ${parsed.conversation_id})`);
            } else if (parsed.event === "step_update") {
              if (parsed.step_update?.text_delta) {
                accumulatedText += parsed.step_update.text_delta;
                process.stdout.write(parsed.step_update.text_delta);
              }
              if (parsed.step_update?.tool_calls && Array.isArray(parsed.step_update.tool_calls)) {
                for (const tc of parsed.step_update.tool_calls) {
                  lastToolCall = tc.name || "tool";
                  console.log(`\n[agy:${role}] ツール実行: ${lastToolCall}`);
                }
              }
            } else if (parsed.event === "result") {
              if (parsed.result?.response) {
                finalResponse = parsed.result.response;
              }
            }
          } catch {
            // JSONでない平文の場合のみ蓄積・出力
            accumulatedText += trimmed + "\n";
            process.stdout.write(`\n[agy:${role}] ${trimmed}\n`);
          }
        }
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        rawStderr += text;
        process.stderr.write(`[agy:ERR] ${text}`);
      });

      child.on("close", (code) => {
        clearInterval(heartbeatTimer);
        process.off("SIGINT", cleanupChild);
        process.off("SIGTERM", cleanupChild);
        process.off("exit", cleanupChild);
        const totalDurationSec = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n[AgyRunner] ${role} エージェント終了 (終了コード: ${code}, 所要時間: ${totalDurationSec}秒)`);

        // 生の NDJSON (rawStdout) は絶対に含めず、エージェントが発言したテキストのみを取り出す
        let outputText = (finalResponse || accumulatedText).trim();

        if (!outputText) {
          if (code !== 0) {
            outputText = `[エラー] エージェント [${role}] が異常終了またはタイムアウトしました (終了コード: ${code})。\n直前のツール実行: ${lastToolCall || "なし"}\n${rawStderr ? `エラー詳細:\n${rawStderr.slice(0, 1000)}` : ""}`.trim();
          } else {
            outputText = `エージェント [${role}] の処理が完了しました。`;
          }
        }

        // コメント長が長すぎる場合のトリム (Backlog上限・可読性対策: 最大7000文字)
        if (outputText.length > 7000) {
          outputText = outputText.slice(0, 7000) + "\n\n...[長文のため以降省略]...";
        }

        const isRejection = checkIsRejection(outputText);

        resolve({
          role,
          success: code === 0,
          summary: `エージェント [${role}] が実行されました (終了コード: ${code})`,
          isRejection,
          output: outputText,
        });
      });

      child.on("error", (err) => {
        clearInterval(heartbeatTimer);
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
        const isRejection = checkIsRejection(stdout || stderr);
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
        output = `【技術レビュー完了】\n- 型安全性、テスト、規約、言語・ライブラリの最新性およびバージョン妥当性を確認しました（LGTM）。\n次は editor による要件レビューです。`;
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
