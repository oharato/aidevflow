/**
 * 非同期排他制御 (Mutex)
 * 同一リポジトリへの同時 Git 操作 (fetch, clone, worktree add 等) による
 * .git/index.lock 衝突を防ぐためのインメモリ非同期ロック。
 */
export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked: boolean = false;

  /**
   * ロックを取得する。解放用コールバック関数 (release) を返す。
   */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.dispatchNext();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.dispatchNext();
          }
        });
      });
    });
  }

  private dispatchNext(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * ロックを取得して指定した非同期処理を実行し、完了時に自動解放する
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(): boolean {
    return this.locked;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

/**
 * キー（リポジトリ名やファイルパス単位）ごとの排他制御マネージャー
 */
export class KeyedAsyncMutex {
  private mutexes: Map<string, AsyncMutex> = new Map();

  getMutex(key: string): AsyncMutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getMutex(key);
    return mutex.runExclusive(fn);
  }

  isLocked(key: string): boolean {
    const mutex = this.mutexes.get(key);
    return mutex ? mutex.isLocked() : false;
  }
}
