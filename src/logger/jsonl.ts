import fs from "fs";
import path from "path";

export type LogLevel = "info" | "warn" | "error" | "debug";

export type EventType =
  | "daemon_start"
  | "daemon_stop"
  | "poll_scan"
  | "issue_detected"
  | "agent_start"
  | "agent_finish"
  | "status_updated"
  | "comment_posted"
  | "status_created"
  | "human_escalation"
  | "quota_locked"
  | "quota_recovered"
  | "error";

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  event: EventType;
  message: string;
  issueKey?: string;
  role?: string;
  durationMs?: number;
  usage?: Record<string, unknown>;
  cumulativeTokens?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface LogMeta {
  issueKey?: string;
  role?: string;
  durationMs?: number;
  usage?: Record<string, unknown>;
  cumulativeTokens?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export class JsonlLogger {
  private logFilePath: string;

  constructor(filePath: string = "logs/aidevflow.jsonl") {
    this.logFilePath = path.resolve(process.cwd(), filePath);
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  log(
    level: LogLevel,
    event: EventType,
    message: string,
    meta?: LogMeta
  ): void {
    const entry: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      issueKey: meta?.issueKey,
      role: meta?.role,
      durationMs: meta?.durationMs,
      usage: meta?.usage,
      cumulativeTokens: meta?.cumulativeTokens,
      data: meta?.data,
    };

    const line = JSON.stringify(entry) + "\n";
    try {
      fs.appendFileSync(this.logFilePath, line, "utf8");
    } catch (err) {
      console.error(`[JsonlLogger] ログ書き込みエラー:`, err);
    }
  }

  info(
    event: EventType,
    message: string,
    meta?: LogMeta
  ): void {
    this.log("info", event, message, meta);
  }

  warn(
    event: EventType,
    message: string,
    meta?: LogMeta
  ): void {
    this.log("warn", event, message, meta);
  }

  error(
    event: EventType,
    message: string,
    meta?: LogMeta
  ): void {
    this.log("error", event, message, meta);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }
}
