import { describe, it, expect } from "vitest";
import { extractRepositoryPaths, extractRepositoryPath } from "../src/git/repo-parser.js";

describe("extractRepositoryPaths (複数リポジトリ対応)", () => {
  it("単一のリポジトリパスを正しく抽出できること", () => {
    const paths = extractRepositoryPaths("リポジトリ: /home/user/my-repo\n課題の詳細です。");
    expect(paths).toEqual(["/home/user/my-repo"]);
  });

  it("箇条書きによる複数リポジトリを正しく抽出できること", () => {
    const multiText = `
【修正対象リポジトリ】
リポジトリ:
- https://github.com/my-org/frontend.git
- https://github.com/my-org/backend.git

【要件】
APIとUIを連携する。
`;
    const paths = extractRepositoryPaths(multiText);
    expect(paths).toEqual([
      "https://github.com/my-org/frontend.git",
      "https://github.com/my-org/backend.git",
    ]);
  });

  it("カンマ区切りの複数リポジトリを正しく抽出できること", () => {
    const commaText = "Repositories: git@github.com:org/app.git, git@github.com:org/api.git";
    const paths = extractRepositoryPaths(commaText);
    expect(paths).toEqual([
      "git@github.com:org/app.git",
      "git@github.com:org/api.git",
    ]);
  });

  it("リポジトリ記載がない場合はフォールバックパスを返すこと", () => {
    const paths = extractRepositoryPaths("リポジトリ記載なし", "/default/repo");
    expect(paths).toEqual(["/default/repo"]);
  });

  it("extractRepositoryPath (単一互換関数) が先頭のリポジトリを返すこと", () => {
    const multiText = `
リポジトリ:
- https://github.com/my-org/frontend.git
- https://github.com/my-org/backend.git
`;
    const single = extractRepositoryPath(multiText);
    expect(single).toBe("https://github.com/my-org/frontend.git");
  });
});
