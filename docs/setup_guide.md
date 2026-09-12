# aidevflow 環境構築 & 運用ガイド

本ドキュメントでは、`aidevflow` の導入要件、環境変数の詳細設定、Backlog への状態登録、および systemd による常駐化手順について解説します。

---

## 1. 必要要件

- **Node.js LTS**: v24.x（`mise` によるバージョン固定推奨）
- **パッケージマネージャー**: `pnpm` (v11.x)
- **バージョン管理ツール**: `mise` (`.mise.toml` 配置済み)
- **エージェント実行環境**:
  - **Google Antigravity CLI (`agy`)**: デフォルトの実行エンジン（PATH に配置済みであること）
  - **Anthropic Claude Code CLI (`claude`)**: `AGENT_RUNNER=claude` を使用する場合
- **GitHub CLI (`gh`)**:
  - プルリクエスト自動作成に利用します。
  - `gh auth status` でログイン済みであることを確認してください。

---

## 2. 環境変数設定 (`.env`)

プロジェクトルートの `.env.example` をコピーして `.env` を作成します：

```bash
cp .env.example .env
```

### 主要パラメータ一覧

| 変数名 | 必須 | デフォルト値 | 説明 |
| :--- | :---: | :--- | :--- |
| `BACKLOG_SPACE_ID` | ○ | - | Backlog のスペースID（例: `ohchans`） |
| `BACKLOG_DOMAIN` | ○ | `backlog.jp` | Backlog のドメイン |
| `BACKLOG_API_KEY` | ○ | - | Backlog 個人設定から発行した API キー |
| `BACKLOG_PROJECT_KEY`| ○ | - | 監視対象の Backlog プロジェクトキー（例: `STUDY`） |
| `BACKLOG_ISSUE_KEY` | - | (未指定) | 特定の1チケットのみを限定監視・デバッグする場合に指定 |
| `POLL_INTERVAL_SEC` | - | `10` | Backlog のポーリング監視間隔（秒） |
| `MAX_CONCURRENCY` | - | `2` | 同時に並行実行する最大チケット数 |
| `MAX_REJECTION_COUNT`| - | `3` | レビュー差し戻しの最大連続回数（超過で確認待ちへ） |
| `AGENT_RUNNER` | - | `agy` | エージェント実行エンジン (`agy` / `claude` / `mock`) |
| `AGY_MODEL` | - | `gemini-3.8-flash-high` | メインエージェントで使用する LLM モデル |
| `AGY_REVIEW_MODEL` | - | `gemini-3.8-flash-medium`| レビューエージェントで使用する LLM モデル |
| `AGY_EFFORT` | - | `low` | 推論エフォート (`low` / `medium` / `high`) |
| `AGENT_TIMEOUT` | - | `20m` | エージェントプロセスのタイムアウト時間 |
| `TARGET_ISSUE_TYPE` | - | (未指定) | 監視対象とする種別名（例: `AI開発`） |
| `TARGET_CATEGORY` | - | (未指定) | 監視対象とするカテゴリー名（例: `AIパイプライン`） |
| `REQUIRE_AI_TAG` | - | `false` | `true` の場合、件名に `[AI]` を含む課題のみ対象化 |
| `DRY_RUN` | - | `false` | `true` の場合、Git push や PR 作成をシミュレート |
| `LOG_FILE_PATH` | - | `logs/aidevflow.jsonl` | 構造化ログ（JSONL）の出力パス |
| `AIDEVFLOW_HOME` | - | `~/aidevflow` | リポジトリ・Worktree のベース配置ディレクトリ |
| `QUOTA_LOCK_FILE_PATH`| - | `.aidevflow.quota.lock` | クォータ枯渇ロックファイルの配置パス |
| `QUOTA_PROBE_INTERVAL_SEC`| - | `300` | クォータ回復プローブの確認間隔（秒） |
| `QUOTA_AUTO_RESUME` | - | `true` | クォータ回復時の中断チケット自動再開 (`true`/`false`) |
| `CLEANUP_INTERVAL_MINUTES`| - | `30` | 完了チケット & クローズ済みPRのリソース定期クリーンアップ間隔（分） |

---

## 3. Backlog へのカスタム状態の一括追加（初回のみ）

プレミアムプラン等でカスタム状態が利用可能な場合、以下のスクリプトを実行してプロジェクトへ一括登録できます：

```bash
pnpm run setup:statuses
```

登録される状態：
- **詳細設計中** (`#3b9dbd` 水色) - Spec-Writer 担当
- **設計レビュー中** (`#868cb7` 青紫) - Spec-Reviewer 担当
- **実装中** (`#eda62a` オレンジ) - Developer 担当
- **技術レビュー中** (`#b0be3c` 黄緑) - Code-Reviewer 担当
- **要件レビュー中** (`#e07b9a` ピンク) - Requirement-Reviewer 担当
- **確認待ち** (`#f42858` 赤) - 人間介入待ち

> [!NOTE]
> フリープラン等でカスタム状態が追加できない場合でも、`aidevflow` は自動検知して「件名プレフィックス ＋ 標準4状態」で動作します。セットアップスクリプトの失敗は無視してそのまま稼働させて問題ありません。

---

## 4. 本格的な常駐化手順 (systemd ユーザーサービス)

サーバーや開発マシン上で、OS起動時の自動起動やプロセスクラッシュ時の自動再起動を行いたい場合は、`systemd --user` を利用します。

### ① ユニットファイルの作成
`~/.config/systemd/user/aidevflow.service` を作成します：

```ini
[Unit]
Description=aidevflow Backlog AI Agent Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/oharato/workspace/aidevflow
ExecStart=/home/oharato/.local/share/mise/shims/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/home/oharato/workspace/aidevflow/.env

[Install]
WantedBy=default.target
```

### ② サービスの有効化と起動
```bash
# ユニットの再読み込み
systemctl --user daemon-reload

# サービス有効化 & 即時起動
systemctl --user enable --now aidevflow

# 稼働ステータス確認
systemctl --user status aidevflow

# リアルタイムログ監視
journalctl --user -u aidevflow -f
```

---

## 5. サンドボックス (Sandbox) 環境における pnpm 設定

制限されたコンテナ環境等で `/home/<user>/.local` が読み取り専用（`ro`）でマウントされている場合、プロジェクトルートの [`.npmrc`](file:///home/oharato/workspace/aidevflow/.npmrc) に書き込み可能なパスを指定してパッケージを管理します：

```ini
registry=https://npm.flatt.tech
store-dir=/tmp/.pnpm-store
cache-dir=/tmp/.pnpm-cache
state-dir=/tmp/.pnpm-state
```
