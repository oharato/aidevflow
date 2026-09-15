/**
 * チケット/課題の詳細本文 (description) から対象リポジトリのパス/URL一覧を抽出する
 * 1つのチケットで複数リポジトリが指定されている場合にも対応
 */
export function extractRepositoryPaths(
  description: string,
  fallbackPath?: string
): string[] {
  if (!description) {
    return fallbackPath ? [fallbackPath] : [];
  }

  const results: string[] = [];
  const lines = description.split(/\r?\n/);
  let inRepoSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 1. セクション開始または単一行指定の判定: リポジトリ:, Repository:, repo: など
    const headerMatch = trimmed.match(
      /^[*`_]*(?:リポジトリ|Repositories|Repository|repos|repo|リポジトリパス)[*`_]*\s*[:：]\s*(.*)$/i
    );

    if (headerMatch) {
      inRepoSection = true;
      const inlineContent = headerMatch[1].trim();

      if (inlineContent) {
        // "リポジトリ: url1, url2" のようにカンマや空白で区切られている場合
        const parts = inlineContent.split(/[,、\s]+/).filter(Boolean);
        for (const part of parts) {
          const clean = cleanRepoToken(part);
          if (clean && !results.includes(clean)) {
            results.push(clean);
          }
        }
      }
      continue;
    }

    // 2. セクション配下の箇条書きリスト (- https://github.com/... または * /path/to/repo)
    if (inRepoSection) {
      // 次のセクション見出しや空行連続でセクション終了判定
      if (/^#{1,6}\s+/.test(trimmed)) {
        inRepoSection = false;
        continue;
      }

      const listMatch = trimmed.match(/^[-*+]\s+[`"']?([^\s`"'\r\n]+)[`"']?/);
      if (listMatch && listMatch[1]) {
        const clean = cleanRepoToken(listMatch[1]);
        if (clean && !results.includes(clean)) {
          results.push(clean);
        }
        continue;
      }

      // 箇条書き以外の行が来たらセクション終了
      if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("*")) {
        inRepoSection = false;
      }
    }

    // 3. 行内の git@ または github.com パターン
    const gitUrlMatch = trimmed.match(/(?:git@[^\s`"'\r\n]+|https?:\/\/github\.com\/[^\s`"'\r\n]+)/i);
    if (gitUrlMatch && !results.includes(gitUrlMatch[0])) {
      const clean = cleanRepoToken(gitUrlMatch[0]);
      if (clean && !results.includes(clean)) {
        results.push(clean);
      }
    }
  }

  if (results.length === 0 && fallbackPath) {
    results.push(fallbackPath);
  }

  return results;
}

/**
 * 後方互換用: 単一リポジトリパスの取得
 */
export function extractRepositoryPath(
  description: string,
  fallbackPath?: string
): string | null {
  const paths = extractRepositoryPaths(description, fallbackPath);
  return paths.length > 0 ? paths[0] : null;
}

function cleanRepoToken(token: string): string {
  const cleaned = token.trim().replace(/^[`"']+|[`"']+$/g, "").replace(/[,\.]$/, "");
  // 安全でないトークン（シェルメタ文字・オプション形式・空白等）は無視する
  return isSafeRepoLocator(cleaned) ? cleaned : "";
}

/**
 * リポジトリ指定子（URL またはローカルパス）として安全な形式か検証する。
 * チケット本文は誰でも編集できる外部入力なので、`git clone` に渡す前に必ずホワイトリストで検証する。
 *
 * 許可する形式:
 *  - https://host/org/repo(.git)
 *  - ssh://git@host/org/repo(.git)
 *  - git@host:org/repo(.git)
 *  - 絶対パス / ~ 始まり / 相対パス（英数字・ドット・ハイフン・アンダースコア・スラッシュのみ）
 *
 * 拒否する形式: 先頭ハイフン（git オプション誤認）、空白、`$ \` ; & | < > ( ) { } * ? ! ' "` 等のシェルメタ文字、`..`
 */
export function isSafeRepoLocator(token: string): boolean {
  if (!token || token.length > 512) return false;
  if (token.startsWith("-")) return false;
  if (/[\s$`;&|<>(){}*?!'"\\\x00-\x1f]/.test(token)) return false;

  const httpsLike = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._\/-]+$/;
  const sshUrl = /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._\/-]+$/;
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._\/-]+$/;
  // ローカルパスは "/" を含むか "~" / "." で始まるものだけ（単語 1 つだけのトークンは
  // 本文中の一般語（例: `whoami`）を誤ってリポジトリ指定と解釈するので除外）
  const localPath = /^(?:~|\.)?\/?[A-Za-z0-9._\/-]+$/;

  if (httpsLike.test(token) || sshUrl.test(token) || scpLike.test(token)) {
    return !token.includes("/../") && !token.endsWith("/..");
  }
  if (localPath.test(token) && (token.includes("/") || /^[~.]/.test(token))) {
    return !token.split("/").includes("..");
  }
  return false;
}
