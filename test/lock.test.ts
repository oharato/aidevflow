import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ProcessLock, isProcessAlive } from "../src/daemon/lock.js";

describe("ProcessLock", () => {
  let tempDir: string;
  let lockFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidevflow-lock-test-"));
    lockFilePath = path.join(tempDir, ".aidevflow.lock");
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it("registerCleanupHandlers は SIGINT/SIGTERM でロックを即時解放しないこと (Graceful Shutdown 中の二重起動防止)", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const beforeExit = process.listenerCount("exit");

    const lock = new ProcessLock(lockFilePath);
    expect(lock.acquire().success).toBe(true);
    lock.registerCleanupHandlers();

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("exit")).toBe(beforeExit + 1);

    // シグナルを模擬しても（ハンドラが無いので）ロックファイルは残る
    expect(fs.existsSync(lockFilePath)).toBe(true);
    lock.release();
    process.removeAllListeners("exit");
  });

  it("isProcessAlive correctly checks process existence", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // 存在しないであろう大きなPID
    expect(isProcessAlive(9999999)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });

  it("successfully acquires and releases lock", () => {
    const lock = new ProcessLock(lockFilePath);
    const result = lock.acquire();

    expect(result.success).toBe(true);
    expect(lock.isHeld()).toBe(true);
    expect(fs.existsSync(lockFilePath)).toBe(true);

    const metadata = lock.readLockMetadata();
    expect(metadata).not.toBeNull();
    expect(metadata?.pid).toBe(process.pid);

    const released = lock.release();
    expect(released).toBe(true);
    expect(lock.isHeld()).toBe(false);
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  it("blocks duplicate acquisition when lock is already held by an alive process", () => {
    // 1つ目のインスタンスでロック取得
    const lock1 = new ProcessLock(lockFilePath);
    const res1 = lock1.acquire();
    expect(res1.success).toBe(true);

    // 擬似的に別プロセスのPID（例えばPID 1: bwrap/init は常に生存している）を書き込む
    const alivePid = 1;
    fs.writeFileSync(
      lockFilePath,
      JSON.stringify({ pid: alivePid, startedAt: new Date().toISOString() })
    );

    // 2つ目のインスタンスが取得を試みる
    const lock2 = new ProcessLock(lockFilePath);
    const res2 = lock2.acquire();

    expect(res2.success).toBe(false);
    expect(res2.existingLock?.pid).toBe(alivePid);

    // lock1 のクリーンアップ
    fs.unlinkSync(lockFilePath);
  });

  it("automatically cleans up stale lock file if previous process is dead", () => {
    const deadPid = 9999999;
    fs.writeFileSync(
      lockFilePath,
      JSON.stringify({
        pid: deadPid,
        startedAt: "2026-09-01T00:00:00.000Z",
        command: "node dist/index.js",
      })
    );

    const lock = new ProcessLock(lockFilePath);
    const result = lock.acquire();

    expect(result.success).toBe(true);
    expect(result.cleanedStaleLock).toBe(true);
    expect(lock.isHeld()).toBe(true);

    const metadata = lock.readLockMetadata();
    expect(metadata?.pid).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  it("handles multiple calls to release safely", () => {
    const lock = new ProcessLock(lockFilePath);
    lock.acquire();
    expect(lock.release()).toBe(true);
    expect(lock.release()).toBe(false);
  });
});
