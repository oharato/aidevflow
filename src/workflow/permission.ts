import childProcess from "child_process";
import { promisify } from "util";
import fs from "fs";
import { READONLY_INSTRUCTION } from "./types.js";

export { READONLY_INSTRUCTION };

type ExecAsyncFn = (cmd: string, options?: any) => Promise<{ stdout: string; stderr: string }>;

function getDefaultExecAsync(): ExecAsyncFn {
  if (typeof childProcess?.exec === "function") {
    return promisify(childProcess.exec) as any;
  }
  return async () => ({ stdout: "", stderr: "" });
}

/**
 * 第 2 層: CLI ツール権限制限引数ヘルパー
 */
export function getDisallowedToolsArgs(
  editAllowed: boolean,
  runnerType: "claude" | "agy"
): string[] {
  if (editAllowed) return [];
  if (runnerType === "claude") {
    return ["--disallowed-tools", "Edit,Write,NotebookEditCell"];
  }
  return [];
}

/**
 * Git 作業ツリーの状態スナップショット
 */
export interface GitSnapshot {
  workDir: string;
  isGitRepo: boolean;
  headCommit?: string;
  statusPorcelain?: string;
}

/**
 * ロールバック検証結果
 */
export interface RollbackResult {
  rolledBack: boolean;
  reasons: string[];
  restoredCommit?: string;
}

/**
 * 第 3 層: Git 差分ガードレール (PermissionGuard)
 * レビュアー役など edit: false のステップで、
 * 万が一エージェントが不正にファイルを編集・コミットした場合に自動検知してロールバックする。
 */
export class PermissionGuard {
  private execFn: ExecAsyncFn;

  constructor(customExecFn?: ExecAsyncFn) {
    this.execFn = customExecFn || getDefaultExecAsync();
  }

  /**
   * ステップ実行前の Git 状態を記録
   */
  async snapshot(workDir: string): Promise<GitSnapshot> {
    if (!workDir || !fs.existsSync(workDir)) {
      return { workDir, isGitRepo: false };
    }

    try {
      await this.execFn("git rev-parse --is-inside-work-tree", { cwd: workDir });
    } catch {
      return { workDir, isGitRepo: false };
    }

    let headCommit: string | undefined;
    try {
      const { stdout } = await this.execFn("git rev-parse HEAD", { cwd: workDir });
      headCommit = stdout.trim();
    } catch {
      // コミットが存在しない初期リポジトリの場合など
      headCommit = undefined;
    }

    let statusPorcelain: string = "";
    try {
      const { stdout } = await this.execFn("git status --porcelain", { cwd: workDir });
      statusPorcelain = stdout.trim();
    } catch {
      statusPorcelain = "";
    }

    return {
      workDir,
      isGitRepo: true,
      headCommit,
      statusPorcelain,
    };
  }

  /**
   * ステップ実行後の状態を検証し、変更があれば自動ロールバックする
   */
  async verifyAndRollback(snapshot: GitSnapshot): Promise<RollbackResult> {
    if (!snapshot.isGitRepo || !snapshot.workDir || !fs.existsSync(snapshot.workDir)) {
      return { rolledBack: false, reasons: [] };
    }

    const reasons: string[] = [];
    let rolledBack = false;

    // 1. コミットハッシュの検証
    let currentHead: string | undefined;
    try {
      const { stdout } = await this.execFn("git rev-parse HEAD", { cwd: snapshot.workDir });
      currentHead = stdout.trim();
    } catch {
      currentHead = undefined;
    }

    // 2. 未コミット変更の検証
    let currentStatus = "";
    try {
      const { stdout } = await this.execFn("git status --porcelain", { cwd: snapshot.workDir });
      currentStatus = stdout.trim();
    } catch {
      currentStatus = "";
    }

    const hasUncommittedChanges =
      currentStatus.length > 0 && currentStatus !== (snapshot.statusPorcelain || "");

    // 3. 不正変更のロールバック
    if (snapshot.headCommit && currentHead && currentHead !== snapshot.headCommit) {
      console.warn(
        `[PermissionGuard] ⚠️ 不正なコミットを検知: ${currentHead} (期待値: ${snapshot.headCommit})。ロールバックします。`
      );
      try {
        await this.execFn(`git reset --hard ${snapshot.headCommit}`, { cwd: snapshot.workDir });
        await this.execFn("git clean -fd", { cwd: snapshot.workDir });
        rolledBack = true;
        reasons.push(
          `読み取り専用ステップ中に新しいコミット (${currentHead.slice(0, 7)}) が作成されたためロールバックしました`
        );
      } catch (err: any) {
        console.error(`[PermissionGuard] ロールバック実行時エラー:`, err);
        reasons.push(`コミットのロールバックに失敗しました: ${err.message}`);
      }
    } else if (hasUncommittedChanges) {
      console.warn(
        `[PermissionGuard] ⚠️ 未コミットの不正なファイル変更を検知。作業ツリーをリセットします。`
      );
      try {
        await this.execFn("git reset --hard HEAD", { cwd: snapshot.workDir });
        await this.execFn("git clean -fd", { cwd: snapshot.workDir });
        rolledBack = true;
        reasons.push(
          "読み取り専用ステップ中に未コミットのファイル作成・編集が検知されたため変更を破棄しました"
        );
      } catch (err: any) {
        console.error(`[PermissionGuard] 作業ツリークリーンアップエラー:`, err);
        reasons.push(`変更の破棄に失敗しました: ${err.message}`);
      }
    }

    return {
      rolledBack,
      reasons,
      restoredCommit: rolledBack ? snapshot.headCommit : undefined,
    };
  }
}
