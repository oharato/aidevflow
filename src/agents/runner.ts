import { spawn } from "child_process";
import type {
  AgentRole,
  AgentContext,
  AgentResult,
  IAgentRunner,
  QuotaProbeResult,
  AgentTokenUsage,
  CumulativeTokenStats,
  QuotaUsageInfo,
  QuotaGroupInfo,
  QuotaBucketInfo,
} from "./types.js";
import { buildAgentPrompt } from "./prompts.js";
import { parseResetDuration } from "../daemon/quota-lock.js";

/**
 * agy -p "/usage" --output-format json の出力をパースして構造化する
 */
export function parseAgyUsageJson(jsonStr: string): QuotaUsageInfo | null {
  try {
    const data = JSON.parse(jsonStr);
    const groupsRaw = data.command?.data?.groups;
    if (!Array.isArray(groupsRaw)) return null;

    const groups: QuotaGroupInfo[] = groupsRaw.map((g: any) => ({
      name: g.name || "Unknown",
      buckets: (g.buckets || []).map((b: any) => ({
        id: b.id || "",
        name: b.name || "",
        window: b.window || "",
        remainingFraction: typeof b.remaining_fraction === "number" ? b.remaining_fraction : 1,
        remainingPercentage: Math.round((typeof b.remaining_fraction === "number" ? b.remaining_fraction : 1) * 100),
        resetTime: b.reset_time || "",
      })),
    }));

    const summaryParts: string[] = [];
    for (const g of groups) {
      const bucketSummaries = g.buckets.map((b) => `${b.name || b.window}: ${b.remainingPercentage}%`).join(", ");
      summaryParts.push(`${g.name} (${bucketSummaries})`);
    }
    const summaryText = summaryParts.join(" | ");

    return {
      groups,
      summaryText,
    };
  } catch {
    return null;
  }
}

/**
 * プロセス全体でのトークン使用量をスレッドセーフに集計・追跡するトラッカー
 */
export class TokenUsageTracker {
  private static totalInputTokens = 0;
  private static totalOutputTokens = 0;
  private static totalThinkingTokens = 0;
  private static totalCacheReadTokens = 0;
  private static totalTokens = 0;
  private static sessionCount = 0;

  static record(usage?: AgentTokenUsage): CumulativeTokenStats {
    if (usage) {
      this.sessionCount++;
      this.totalInputTokens += usage.inputTokens || 0;
      this.totalOutputTokens += usage.outputTokens || 0;
      this.totalThinkingTokens += usage.thinkingTokens || 0;
      this.totalCacheReadTokens += usage.cacheReadTokens || 0;
      this.totalTokens += usage.totalTokens || 0;
    }
    return this.getTotals();
  }

  static getTotals(): CumulativeTokenStats {
    return {
      sessionCount: this.sessionCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalThinkingTokens: this.totalThinkingTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalTokens: this.totalTokens,
    };
  }

  static getSummary(): string {
    return `[トークン累積消費] セッション数: ${this.sessionCount}回 | 入力: ${this.totalInputTokens.toLocaleString()} | 出力: ${this.totalOutputTokens.toLocaleString()} (思考: ${this.totalThinkingTokens.toLocaleString()}) | キャッシュ読込: ${this.totalCacheReadTokens.toLocaleString()} | 合計: ${this.totalTokens.toLocaleString()} tokens`;
  }

  static reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalThinkingTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalTokens = 0;
    this.sessionCount = 0;
  }
}

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
    const isReview = role === "spec-reviewer" || role === "code-reviewer" || role === "requirement-reviewer";
    const selectedModel = (isReview && this.reviewModel) ? this.reviewModel : this.model;

    console.log(
      `[AgyRunner] Spawning Antigravity CLI (agy) for role: ${role}... (model: ${selectedModel || "default"}, effort: ${this.effort}, timeout: ${this.timeout})`
    );

    return new Promise<AgentResult>((resolve, reject) => {
      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--print-timeout",
        this.timeout,
        "--output-format",
        "stream-json",
      ];

      if (selectedModel) {
        args.push("--model", selectedModel);
      }

      // モデル名末尾に -low, -medium, -high が含まれている場合はモデル名自体で effort が指定されているため
      // --effort を渡すとコンフリクト (conflicts with --effort=...) エラーになる。
      // モデル名に effort suffix が含まれていない場合のみ --effort を付与する。
      const hasEffortInModelName = selectedModel && /-(low|medium|high)$/i.test(selectedModel);
      if (this.effort && !hasEffortInModelName) {
        args.push("--effort", this.effort);
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
      let parsedUsage: AgentTokenUsage | undefined;

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
              if (parsed.result?.usage) {
                const u = parsed.result.usage;
                parsedUsage = {
                  inputTokens: u.input_tokens,
                  outputTokens: u.output_tokens,
                  thinkingTokens: u.thinking_tokens,
                  cacheReadTokens: u.cache_read_tokens,
                  totalTokens: u.total_tokens,
                };
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

        if (parsedUsage) {
          TokenUsageTracker.record(parsedUsage);
          console.log(
            `[AgyRunner] 📊 [${role}] トークン消費: 入力=${parsedUsage.inputTokens?.toLocaleString()} / 出力=${parsedUsage.outputTokens?.toLocaleString()} (思考=${parsedUsage.thinkingTokens?.toLocaleString() || 0}) / キャッシュ=${parsedUsage.cacheReadTokens?.toLocaleString() || 0} / 合計=${parsedUsage.totalTokens?.toLocaleString()} tokens`
          );
          console.log(`[AgyRunner] 📈 ${TokenUsageTracker.getSummary()}`);
        }

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
          usage: parsedUsage,
          durationSeconds: totalDurationSec,
        });
      });

      child.on("error", (err) => {
        clearInterval(heartbeatTimer);
        console.error(`[AgyRunner] Failed to spawn agy CLI:`, err);
        reject(err);
      });
    });
  }

  /**
   * agy -p "/usage" --output-format json により、トークン消費ゼロで現在のクォータ残量（%）とリセット日時を取得
   */
  async getQuotaUsage(): Promise<QuotaUsageInfo | null> {
    return new Promise<QuotaUsageInfo | null>((resolve) => {
      const child = spawn(
        "agy",
        ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"],
        {
          cwd: this.workDir,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0 && stdout) {
          const parsed = parseAgyUsageJson(stdout);
          resolve(parsed);
        } else {
          resolve(null);
        }
      });

      child.on("error", () => {
        resolve(null);
      });
    });
  }

  async probeQuotaRecovery(): Promise<QuotaProbeResult> {
    console.log("[AgyRunner] クォータ回復プローブを実行中 (agy /usage による残量・リセット確認)...");
    try {
      const quotaInfo = await this.getQuotaUsage();
      if (quotaInfo && quotaInfo.groups.length > 0) {
        let isDepleted = false;
        let resetDurationSec: number | null = null;
        let resetDurationText: string | undefined = undefined;
        let depletedBucketName = "";

        for (const group of quotaInfo.groups) {
          for (const bucket of group.buckets) {
            if (bucket.remainingFraction <= 0) {
              isDepleted = true;
              depletedBucketName = `${group.name} - ${bucket.name}`;
              if (bucket.resetTime) {
                const diffMs = new Date(bucket.resetTime).getTime() - Date.now();
                if (diffMs > 0) {
                  resetDurationSec = Math.ceil(diffMs / 1000);
                  const mins = Math.ceil(diffMs / 60000);
                  resetDurationText = `${mins}分後`;
                }
              }
            }
          }
        }

        if (isDepleted) {
          console.log(`[AgyRunner] ⚠️ クォータ残量不足検知: ${depletedBucketName} (残量: 0%)`);
          return {
            recovered: false,
            resetDurationSec,
            resetDurationText,
            errorMessage: `クォータ上限到達中: ${depletedBucketName}`,
            quotaUsage: quotaInfo,
          };
        }

        console.log(`[AgyRunner] 🎉 クォータ残量を確認 (回復済み): ${quotaInfo.summaryText}`);
        return {
          recovered: true,
          quotaUsage: quotaInfo,
        };
      }
    } catch (err: any) {
      console.warn(`[AgyRunner] /usage によるクォータ確認で例外: ${err.message}。ping フォールバックを実行します。`);
    }

    // フォールバック: 従来の軽量 ping チェック
    console.log("[AgyRunner] (フォールバック) agy ping チェックを実行します...");
    return new Promise<QuotaProbeResult>((resolve) => {
      const child = spawn("agy", ["-p", "ping", "--dangerously-skip-permissions", "--print-timeout", "30s", "--output-format", "text"], {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        const fullOutput = `${stdout}\n${stderr}`;
        const isQuota = /quota|rate\s*limit|429/i.test(fullOutput);
        if (isQuota) {
          const resetInfo = parseResetDuration(fullOutput);
          resolve({
            recovered: false,
            resetDurationSec: resetInfo?.durationSec ?? null,
            resetDurationText: resetInfo?.durationText,
            errorMessage: fullOutput.slice(0, 500).trim(),
          });
        } else {
          resolve({
            recovered: true,
          });
        }
      });

      child.on("error", (err) => {
        resolve({
          recovered: false,
          errorMessage: err.message,
        });
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

  async probeQuotaRecovery(): Promise<QuotaProbeResult> {
    console.log("[ClaudeCliRunner] クォータ回復プローブを実行中 (claude 軽量チェック)...");
    return new Promise<QuotaProbeResult>((resolve) => {
      const child = spawn("claude", ["-p", "ping"], {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        const fullOutput = `${stdout}\n${stderr}`;
        const isQuota = /quota|rate\s*limit|429/i.test(fullOutput);
        if (isQuota) {
          const resetInfo = parseResetDuration(fullOutput);
          resolve({
            recovered: false,
            resetDurationSec: resetInfo?.durationSec ?? null,
            resetDurationText: resetInfo?.durationText,
            errorMessage: fullOutput.slice(0, 500).trim(),
          });
        } else {
          resolve({
            recovered: true,
          });
        }
      });

      child.on("error", (err) => {
        resolve({
          recovered: false,
          errorMessage: err.message,
        });
      });
    });
  }
}

/**
 * テスト/モック実行用ランナー
 */
export class MockRunner implements IAgentRunner {
  private quotaRecovered: boolean = true;

  setQuotaRecovered(recovered: boolean): void {
    this.quotaRecovered = recovered;
  }

  async probeQuotaRecovery(): Promise<QuotaProbeResult> {
    console.log(`[MockRunner] クォータ回復プローブを実行中 (mock状態: ${this.quotaRecovered ? "回復済み" : "クォータ枯渇中"})...`);
    return {
      recovered: this.quotaRecovered,
      errorMessage: this.quotaRecovered ? undefined : "Mock: Individual quota reached. Resets in 30m.",
      resetDurationSec: this.quotaRecovered ? undefined : 1800,
      resetDurationText: this.quotaRecovered ? undefined : "30m",
    };
  }

  async run(role: AgentRole, context: AgentContext): Promise<AgentResult> {
    console.log(`[MockRunner] Simulating role: ${role} on issue: ${context.issueKey}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let output = "";
    let isRejection = false;

    switch (role) {
      case "spec-writer":
        output = `【詳細仕様書作成完了】\n- 対象: ${context.issueSummary}\n- 仕様・構成案を策定しました。\n次は spec-reviewer による詳細仕様レビューです。`;
        break;
      case "spec-reviewer":
        output = `【詳細仕様レビュー完了】\n- 仕様・設計内容を確認し、問題ありませんでした（LGTM）。\n次は developer による実装です。`;
        break;
      case "developer":
        output = `【実装完了】\n- 設計書に基づいてコードとテストを実装しました。\n次は code-reviewer による技術レビューです。`;
        break;
      case "code-reviewer":
        output = `【技術レビュー完了】\n- 型安全性、テスト、規約、言語・ライブラリの最新性およびバージョン妥当性を確認しました（LGTM）。\n次は requirement-reviewer による要件レビューです。`;
        break;
      case "requirement-reviewer":
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
