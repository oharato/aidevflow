import fs from "fs";
import path from "path";

export interface LockMetadata {
  pid: number;
  startedAt: string;
  command?: string;
}

export interface AcquireResult {
  success: boolean;
  existingLock?: LockMetadata;
  cleanedStaleLock?: boolean;
}

/**
 * プロセスが現在生存しているかを判定する。
 * kill(pid, 0) はシグナルを送信せず、プロセスの存在確認のみを行う。
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM の場合は他ユーザーのプロセスとして存在している
    return err.code === "EPERM";
  }
}

export class ProcessLock {
  private lockFilePath: string;
  private isAcquired: boolean = false;
  private cleanupRegistered: boolean = false;

  constructor(lockFilePath: string = ".aidevflow.lock") {
    this.lockFilePath = path.resolve(lockFilePath);
  }

  getLockFilePath(): string {
    return this.lockFilePath;
  }

  isHeld(): boolean {
    return this.isAcquired;
  }

  /**
   * 現在のロックファイルからメタデータを読み取る
   */
  readLockMetadata(): LockMetadata | null {
    if (!fs.existsSync(this.lockFilePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(this.lockFilePath, "utf8");
      const parsed = JSON.parse(content);
      if (typeof parsed.pid === "number") {
        return parsed as LockMetadata;
      }
    } catch {
      // 破損したファイル等の場合
    }
    return null;
  }

  /**
   * 排他ロックを取得する。
   * - すでに有効なプロセスがロックを保持している場合は success: false を返す。
   * - 前回のプロセスが停止している古いロック（Stale lock）の場合は自動で削除して新規取得する。
   */
  acquire(): AcquireResult {
    let cleanedStaleLock = false;

    if (fs.existsSync(this.lockFilePath)) {
      const metadata = this.readLockMetadata();
      if (metadata && isProcessAlive(metadata.pid)) {
        // 自プロセスがすでに取得している場合
        if (metadata.pid === process.pid) {
          this.isAcquired = true;
          return { success: true };
        }
        return {
          success: false,
          existingLock: metadata,
        };
      }

      // プロセスが死んでいる、またはファイルが不正な場合は古いロックを削除
      try {
        fs.unlinkSync(this.lockFilePath);
        cleanedStaleLock = true;
      } catch {
        // 並行削除等で消えている場合などは無視
      }
    }

    const metadata: LockMetadata = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: process.argv.slice(1).join(" "),
    };

    try {
      // wx フラグでアトミックに排他作成
      fs.writeFileSync(this.lockFilePath, JSON.stringify(metadata, null, 2), {
        flag: "wx",
      });
      this.isAcquired = true;
      return { success: true, cleanedStaleLock };
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // 瞬間的な競合で別プロセスが直前に作成した場合
        const existing = this.readLockMetadata();
        return {
          success: false,
          existingLock: existing || undefined,
        };
      }
      throw err;
    }
  }

  /**
   * ロックを解放する。
   * 自プロセスが作成したロックファイルの場合のみ安全に削除する。
   */
  release(): boolean {
    if (!this.isAcquired) {
      return false;
    }

    try {
      if (fs.existsSync(this.lockFilePath)) {
        const metadata = this.readLockMetadata();
        if (metadata && metadata.pid === process.pid) {
          fs.unlinkSync(this.lockFilePath);
        }
      }
      this.isAcquired = false;
      return true;
    } catch {
      this.isAcquired = false;
      return false;
    }
  }

  /**
   * プロセス終了シグナルや例外ハンドラを登録し、終了時に確実にロックを解放する
   */
  registerCleanupHandlers(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => {
      this.release();
    };

    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
}
