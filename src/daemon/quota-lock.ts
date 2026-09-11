import fs from "fs";
import path from "path";
import type { AgentRole } from "../agents/types.js";

export interface QuotaLockMetadata {
  lockedAt: string;
  resetsAt: string | null;
  resetDurationSec: number | null;
  resetDurationText?: string;
  role: AgentRole;
  issueKey: string;
  errorMessage: string;
  lastProbeAt?: string;
  probeCount?: number;
}

/**
 * エラーメッセージやログからリセット時間（例: "Resets in 2h21m6s."）をパースする
 */
export function parseResetDuration(text: string): { durationSec: number; durationText: string } | null {
  if (!text) return null;

  const match = text.match(/resets?\s+in\s+([0-9hms\s]+?)(?:\.|$|\n|\r)/i);
  if (!match) return null;

  const durationText = match[1].trim();
  let totalSec = 0;

  const hourMatch = durationText.match(/(\d+)\s*h/i);
  const minMatch = durationText.match(/(\d+)\s*m(?!s)/i);
  const secMatch = durationText.match(/(\d+)\s*s/i);

  if (hourMatch) totalSec += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) totalSec += parseInt(minMatch[1], 10) * 60;
  if (secMatch) totalSec += parseInt(secMatch[1], 10);

  if (totalSec <= 0) return null;

  return {
    durationSec: totalSec,
    durationText,
  };
}

export class QuotaLockManager {
  private lockFilePath: string;

  constructor(lockFilePath: string = ".aidevflow.quota.lock") {
    this.lockFilePath = path.resolve(lockFilePath);
  }

  getLockFilePath(): string {
    return this.lockFilePath;
  }

  /**
   * クォータロックファイルが存在するか確認する
   */
  isLocked(): boolean {
    return fs.existsSync(this.lockFilePath);
  }

  /**
   * ロックファイルからメタデータを読み取る
   */
  readMetadata(): QuotaLockMetadata | null {
    if (!fs.existsSync(this.lockFilePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(this.lockFilePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && parsed.lockedAt) {
        return parsed as QuotaLockMetadata;
      }
    } catch {
      // 破損ファイル等
    }
    return null;
  }

  /**
   * クォータロックを取得（ファイル作成）する
   */
  acquire(metadata: Omit<QuotaLockMetadata, "lockedAt">): QuotaLockMetadata {
    const fullMetadata: QuotaLockMetadata = {
      lockedAt: new Date().toISOString(),
      ...metadata,
    };

    const dir = path.dirname(this.lockFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.lockFilePath, JSON.stringify(fullMetadata, null, 2), "utf8");
    return fullMetadata;
  }

  /**
   * メタデータを更新する（プローブ時刻や回数など）
   */
  updateMetadata(updates: Partial<QuotaLockMetadata>): QuotaLockMetadata | null {
    const current = this.readMetadata();
    if (!current) return null;

    const updated: QuotaLockMetadata = {
      ...current,
      ...updates,
    };

    fs.writeFileSync(this.lockFilePath, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  }

  /**
   * ロックを解放（ファイル削除）する
   */
  release(): boolean {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * リセット予定時刻までの残り時間（ミリ秒）を取得する。
   * - resetsAt が未定義・null の場合は null
   * - 既に過ぎている場合は 0
   */
  getTimeUntilResetMs(): number | null {
    const metadata = this.readMetadata();
    if (!metadata || !metadata.resetsAt) {
      return null;
    }

    const resetTime = new Date(metadata.resetsAt).getTime();
    if (isNaN(resetTime)) {
      return null;
    }

    const diff = resetTime - Date.now();
    return Math.max(0, diff);
  }
}
