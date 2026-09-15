import { execFile, type ExecFileOptions } from "child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * シェルを介さずにコマンドを実行する（execFile ラッパー）。
 * チケット本文などの外部入力を含む引数は必ずこの関数経由で配列として渡し、
 * 文字列連結によるシェルインジェクション（`$(...)`, バッククォート, `;` 等）を構造的に防ぐ。
 */
export function runCommand(
  file: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error) {
          const e = error as Error & { stdout?: string; stderr?: string };
          e.stdout = out;
          e.stderr = err;
          if (err && !e.message.includes(err.trim())) {
            e.message = `${e.message}\n${err.trim()}`;
          }
          reject(e);
          return;
        }
        resolve({ stdout: out, stderr: err });
      }
    );
  });
}

/**
 * Git のブランチ名・チケットキーとして安全な文字列か検証する。
 * パス区切り・親ディレクトリ参照・先頭ハイフン（オプション誤認）を拒否する。
 */
export function isSafeRefName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith("-") || name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}
