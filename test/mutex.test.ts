import { describe, it, expect } from "vitest";
import { AsyncMutex, KeyedAsyncMutex } from "../src/git/mutex.js";

describe("AsyncMutex (非同期排他制御)", () => {
  it("同一リソースに対する処理が直列に順次実行されること", async () => {
    const mutex = new AsyncMutex();
    const executionOrder: number[] = [];
    let concurrentCount = 0;
    let maxConcurrentObserved = 0;

    const task = async (id: number, delayMs: number) => {
      return mutex.runExclusive(async () => {
        concurrentCount++;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentCount);
        executionOrder.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        concurrentCount--;
        return id;
      });
    };

    // 3つのタスクを同時に投入
    const results = await Promise.all([
      task(1, 30),
      task(2, 20),
      task(3, 10),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(maxConcurrentObserved).toBe(1); // 同時実行数は常に最大1
    expect(mutex.isLocked()).toBe(false);
  });

  it("例外が発生した場合でも確実にロックが解放され後続タスクが実行されること", async () => {
    const mutex = new AsyncMutex();

    const failingTask = async () => {
      return mutex.runExclusive(async () => {
        throw new Error("Git command failed");
      });
    };

    const succeedingTask = async () => {
      return mutex.runExclusive(async () => {
        return "success";
      });
    };

    await expect(failingTask()).rejects.toThrow("Git command failed");
    expect(mutex.isLocked()).toBe(false);

    const result = await succeedingTask();
    expect(result).toBe("success");
    expect(mutex.isLocked()).toBe(false);
  });
});

describe("KeyedAsyncMutex (キー付き排他制御)", () => {
  it("同一キーは直列化され、異なるキーは並行に実行されること", async () => {
    const keyedMutex = new KeyedAsyncMutex();
    const timeline: string[] = [];

    const task = async (key: string, name: string, delayMs: number) => {
      return keyedMutex.runExclusive(key, async () => {
        timeline.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        timeline.push(`${name}-end`);
        return name;
      });
    };

    // repo-A に 2 タスク、repo-B に 1 タスク投入
    await Promise.all([
      task("repo-A", "A1", 40),
      task("repo-A", "A2", 20),
      task("repo-B", "B1", 20),
    ]);

    // B1 は repo-B のため、repo-A の A1 と並行して開始・終了する
    expect(timeline[0]).toBe("A1-start");
    expect(timeline[1]).toBe("B1-start");
    // B1 は 20ms で終わるので A1(40ms) より先に終わる
    expect(timeline.indexOf("B1-end")).toBeLessThan(timeline.indexOf("A1-end"));
    // A2 は A1 が終わるまで開始しない
    expect(timeline.indexOf("A2-start")).toBeGreaterThan(timeline.indexOf("A1-end"));
  });
});
