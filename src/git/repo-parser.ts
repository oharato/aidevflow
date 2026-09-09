/**
 * Backlog チケットの詳細本文 (description) から対象リポジトリのパス/URL一覧を抽出する
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
  return token.trim().replace(/^[`"']+|[`"']+$/g, "").replace(/[,\.]$/, "");
}
