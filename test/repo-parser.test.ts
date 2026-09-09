import { extractRepositoryPaths, extractRepositoryPath } from "../src/git/repo-parser.js";

async function runRepoParserTests() {
  console.log("=== extractRepositoryPaths (複数リポジトリ対応) 単体テスト開始 ===");

  // 1. 単一指定
  const single1 = extractRepositoryPaths("リポジトリ: /home/user/my-repo\n課題の詳細です。");
  if (single1.length !== 1 || single1[0] !== "/home/user/my-repo") {
    throw new Error(`単一指定 1 失敗: ${JSON.stringify(single1)}`);
  }
  console.log("✓ 単一指定 1 合格");

  // 2. 箇条書きによる複数指定
  const multiText = `
【修正対象リポジトリ】
リポジトリ:
- https://github.com/my-org/frontend.git
- https://github.com/my-org/backend.git

【要件】
APIとUIを連携する。
`;
  const multiPaths = extractRepositoryPaths(multiText);
  if (multiPaths.length !== 2 || multiPaths[0] !== "https://github.com/my-org/frontend.git" || multiPaths[1] !== "https://github.com/my-org/backend.git") {
    throw new Error(`複数指定 (箇条書き) 失敗: ${JSON.stringify(multiPaths)}`);
  }
  console.log("✓ 複数指定 (箇条書き) 合格:", multiPaths);

  // 3. カンマ区切りによる複数指定
  const commaText = "Repositories: git@github.com:org/app.git, git@github.com:org/api.git";
  const commaPaths = extractRepositoryPaths(commaText);
  if (commaPaths.length !== 2) {
    throw new Error(`複数指定 (カンマ) 失敗: ${JSON.stringify(commaPaths)}`);
  }
  console.log("✓ 複数指定 (カンマ区切り) 合格:", commaPaths);

  // 4. フォールバック
  const fallbackPaths = extractRepositoryPaths("リポジトリ記載なし", "/default/repo");
  if (fallbackPaths.length !== 1 || fallbackPaths[0] !== "/default/repo") {
    throw new Error(`フォールバック失敗: ${JSON.stringify(fallbackPaths)}`);
  }
  console.log("✓ フォールバック合格");

  // 5. extractRepositoryPath (単一互換関数)
  const singleCompat = extractRepositoryPath(multiText);
  if (singleCompat !== "https://github.com/my-org/frontend.git") {
    throw new Error(`単一互換関数失敗: ${singleCompat}`);
  }
  console.log("✓ 単一互換関数合格");

  console.log("✓ extractRepositoryPaths 全テスト合格！");
}

runRepoParserTests().catch((err) => {
  console.error("テスト失敗:", err);
  process.exit(1);
});
