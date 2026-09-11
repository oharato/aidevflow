# aidevflow Project Guidelines

Antigravity (agy) における `aidevflow` プロジェクト固有の開発・運用ガイドラインです。

## 1. Backlog 操作における公式 CLI `bee` の優先使用
- **Backlog 操作のデフォルトツール (`bee`)**:
  - Backlog に関する調査、チケット情報の取得、コメント履歴の確認、ステータス変更、コメント投稿等の操作には、直接の curl や生の REST API ではなく、**Backlog 公式 CLI `bee` (`@nulab/bee`)** を必ず使用すること。
- **インストールおよび実行環境**:
  - プロジェクトに `@nulab/bee` が導入されており、PATH（`~/.gemini/antigravity-cli/bin/bee`）に配置済みのため、ターミナルから直接 `bee` コマンドを実行可能。
  - スペース `ohchans.backlog.jp` に対して認証済み。
- **代表的なコマンド例**:
  - **課題の確認**:
    ```bash
    bee issue view <ISSUE_KEY>
    ```
  - **コメント履歴の確認**:
    ```bash
    bee issue comment <ISSUE_KEY> --list
    ```
  - **課題の編集（件名・ステータス更新等）**:
    ```bash
    # 例: 件名とステータスIDを指定して更新
    bee issue edit <ISSUE_KEY> -t "[技術レビュー中] チケット名" -S 2
    ```
  - **コメント投稿**:
    ```bash
    bee issue comment <ISSUE_KEY> -b "コメント本文"
    # 長文の場合（標準入力からパイプ）
    cat comment.md | bee issue comment <ISSUE_KEY>
    ```
  - **プロジェクト・ステータス一覧の確認**:
    ```bash
    bee project view <PROJECT_KEY>
    bee status list -p <PROJECT_KEY>
    ```

## 2. 開発・設計方針
- **TypeScript & pnpm の遵守**:
  - スクリプト・実装・調査ツールはすべて TypeScript と `pnpm` を使用する。
  - パッケージ追加時は7日間のクールダウン期間（リリース後7日以上経過）を満たす最新安定版を指定すること。
- **エージェント実行・エラーハンドリング**:
  - Antigravity CLI (`agy`) や Claude Code CLI (`claude`) の実行時に LLM クォータ制限（Quota Reached）や異常終了が発生した場合は、フェーズを進めず即座にパイプラインを「確認待ち」に一時停止（エスカレーション）すること。
- **ドキュメンテーション重視 (Documentation First)**:
  - 仕様変更や機能追加、トラブルシューティング手順はコードと同時に `docs/` および `README.md` を更新し、常にドキュメントを最新の正本に保つこと。
