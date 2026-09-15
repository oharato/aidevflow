# aidevflow 環境構築 & 運用ガイド

## 📚 関連ドキュメント
- 📝 **[チケット起票テンプレート](TICKET_TEMPLATE.md)** (要件漏れ防止・機能/非機能/DoDチェックリスト)
- 🤖 **[プロジェクト規約テンプレート (AGENTS.md)](AGENTS_TEMPLATE.md)** (被開発リポジトリ用非機能要件・アーキテクチャ標準の正本テンプレート)
- 🏛️ **[システムアーキテクチャ仕様書](architecture.md)** (全体構成・状態遷移・エージェント役割)
- 🌐 **[Agentic SDLC 業界動向 & アーキテクチャ比較](agentic_sdlc_landscape.md)** (業界動向・命名定義・既存FW比較・Backlog=State設計の強み)
- 🚀 **[環境構築 & 運用ガイド](setup_guide.md)** (本ドキュメント)
- 🔀 **[並行開発 & Git Worktree 仕様書](concurrency_worktree.md)** (Worktree分離・並行数制御・Git排他制御)
- ⚡ **[クォータ消費最適化 & 軽量パイプライン仕様書](quota_optimization.md)** (Fast/Researchモード・モデル最適化)
- 🛡️ **[トラブルシューティング & エスカレーション仕様書](troubleshooting.md)** (無限ループ防止・クォータ枯渇・エスカレーション)
- 🎼 **[宣言的ワークフローエンジン & 権限制御設計書](declarative_workflow_engine_design.md)** (YAML定義・決定キーワード・edit:false多層防御)
- 🧩 **[Issue Tracker (BTS) 抽象化設計書](issue_tracker_abstraction.md)** (BTS抽象化・BacklogAdapter・MockTracker)
- 👥 **[デーモン配置設計書](deployment_topology.md)** (個人用デーモン vs チーム用デーモン・担当者フィルタ)

---

本ドキュメントでは、`aidevflow` の導入要件、設定ファイル（config.yml / config.local.yml / .env）、Backlog への状態登録、および systemd による常駐化手順について解説します。

---

## 1. 必要要件

- **Node.js LTS**: v24.x（`mise` によるバージョン固定推奨）
- **パッケージマネージャー**: `pnpm` (v11.x)
- **バージョン管理ツール**: `mise` (`.mise.toml` 配置済み)
- **エージェント実行環境**:
  - **Anthropic Claude Code CLI (`claude`)**: 既定の実行エンジン（`claude` でログイン済みであること）
  - **Google Antigravity CLI (`agy`)**: `agent.runner: agy` を使用する場合
- **GitHub CLI (`gh`)**:
  - プルリクエスト自動作成に利用します。
  - `gh auth status` でログイン済みであることを確認してください。

---

## 2. 設定ファイル（config.yml / config.local.yml / .env）

設定は「秘密情報」「チーム共通」「個人・マシン固有」の 3 種類に分けて置きます。読み込みは後勝ちで、
`コード既定値 < config.yml < config.local.yml < 環境変数` の順に上書きされます。

| ファイル | 置くもの | Git |
| :--- | :--- | :---: |
| `.env` | 秘密情報だけ（`BACKLOG_API_KEY`、チーム用なら `ANTHROPIC_API_KEY`） | 除外 |
| `config.yml` | チーム共通の設定（ランナー・並行数・掃除間隔など。公開して差し支えない値のみ） | コミット |
| `config.local.yml` | 個人・マシン固有の設定（スペースID・プロジェクトキー・配置パス） | 除外 |

環境変数は一時的な上書き（例: `DRY_RUN=true pnpm start`）と systemd の `EnvironmentFile` 用に残しています。

### 初回セットアップ

```bash
cp config.local.yml.example config.local.yml   # スペースID・プロジェクトキーを記入
printf 'BACKLOG_API_KEY=<自分の API キー>\n' > .env
chmod 600 .env
```

### 設定項目一覧

「YAML キー」は `config.yml` / `config.local.yml` での書き方、「環境変数」は同じ値を上書きするときの名前です。

**tracker（課題管理システム）**

| YAML キー | 環境変数 | 必須 | 既定値 | 説明 |
| :--- | :--- | :---: | :--- | :--- |
| `tracker.type` | `TRACKER_TYPE` | - | `backlog` | `backlog` / `mock` / `github`（準備中）。無効値は起動エラー |
| `tracker.backlog.space_id` | `BACKLOG_SPACE_ID` | ○ | - | スペースID（`config.local.yml`） |
| `tracker.backlog.domain` | `BACKLOG_DOMAIN` | - | `backlog.jp` | ドメイン |
| `tracker.backlog.project_key` | `BACKLOG_PROJECT_KEY` | ○ | - | 監視対象プロジェクトキー（`config.local.yml`） |
| `tracker.backlog.issue_key` | `BACKLOG_ISSUE_KEY` | - | (未指定) | 特定の 1 チケットのみ監視・デバッグ（フィルタも適用） |
| (なし) | `BACKLOG_API_KEY` | ○ | - | API キー。`.env` にだけ書く |
| `tracker.filter.only_assigned_to_me` | `ONLY_ASSIGNED_TO_ME` | - | `false` | 担当者が API キー所有者のチケットのみ対象。個人用デーモンでは `true`（[配置設計書](deployment_topology.md)） |
| `tracker.filter.target_issue_type` | `TARGET_ISSUE_TYPE` | - | (未指定) | 対象とする種別名 |
| `tracker.filter.target_category` | `TARGET_CATEGORY` | - | (未指定) | 対象とするカテゴリー名 |
| `tracker.filter.require_ai_tag` | `REQUIRE_AI_TAG` | - | `false` | 件名に `[AI]` を含む課題のみ対象 |

**agent（エージェント実行エンジン）**

| YAML キー | 環境変数 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `agent.runner` | `AGENT_RUNNER` | `claude` | `claude` / `agy` / `mock`。無効値は起動エラー |
| `agent.timeout` | `AGENT_TIMEOUT` | `20m` | 1 ステップのタイムアウト（`90s` / `1h` も可） |
| `agent.claude.model` | `CLAUDE_MODEL` | (CLI 既定) | `claude --model` に渡すモデル名 |
| `agent.agy.model` | `AGY_MODEL` | `gemini-3.8-flash-high` | agy のメインモデル |
| `agent.agy.review_model` | `AGY_REVIEW_MODEL` | (未指定) | agy のレビュー用モデル |
| `agent.agy.effort` | `AGY_EFFORT` | `low` | `low` / `medium` / `high` |
| `agent.work_dir` | `AGENT_WORKDIR` | カレント | worktree が渡されない場合の予備作業ディレクトリ |

**daemon / paths / quota / cleanup**

| YAML キー | 環境変数 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `daemon.poll_interval_sec` | `POLL_INTERVAL_SEC` | `10` | ポーリング間隔（秒） |
| `daemon.max_concurrency` | `MAX_CONCURRENCY` | `2` | 同時並行チケット数 |
| `daemon.max_rejection_count` | `MAX_REJECTION_COUNT` | `3` | 差し戻し連続上限（到達で確認待ち） |
| `daemon.max_consecutive_failures` | `MAX_CONSECUTIVE_FAILURES` | `5` | 準備エラー連続上限（到達で確認待ち） |
| `daemon.require_human_spec_approval` | `REQUIRE_HUMAN_SPEC_APPROVAL` | `false` | 設計レビュー後に人間承認を必須化 |
| `daemon.dry_run` | `DRY_RUN` | `false` | push / PR 作成 / 削除をシミュレートのみ |
| `daemon.log_file_path` | `LOG_FILE_PATH` | `logs/aidevflow.jsonl` | 構造化ログの出力先 |
| `paths.home` | `AIDEVFLOW_HOME` | `~/aidevflow` | リポジトリ・worktree の配置先（`~` 展開可） |
| `paths.default_repo_path` | `DEFAULT_REPO_PATH` | (未指定) | チケットにリポジトリ記載が無いときの予備。通常は未指定（エラー停止） |
| `paths.workflows_dir` | `AIDEVFLOW_WORKFLOWS_DIR` | `workflows` | ワークフロー定義の配置先 |
| `quota.lock_file_path` | `QUOTA_LOCK_FILE_PATH` | `.aidevflow.quota.lock` | クォータ枯渇ロックの配置先 |
| `quota.probe_interval_sec` | `QUOTA_PROBE_INTERVAL_SEC` | `300` | 回復プローブ間隔（秒） |
| `quota.auto_resume` | `QUOTA_AUTO_RESUME` | `true` | 回復時に中断チケットを自動再開 |
| `cleanup.interval_minutes` | `CLEANUP_INTERVAL_MINUTES` | `30` | 完了チケットのリソース掃除間隔（分） |

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
EnvironmentFile=/home/oharato/workspace/aidevflow/.env   # 秘密情報のみ。他の設定は config.yml / config.local.yml から読まれる

[Install]
WantedBy=default.target
```

> [!NOTE]
> **個人用デーモン運用（共用 VM に各開発者が自分のユーザーで常駐させる場合）**
> - `config.yml` の `tracker.filter.only_assigned_to_me` が `true` であることを確認し、`config.local.yml` に自分のスペースID・プロジェクトキー、`.env` に自分の API キーを置きます。`claude` / `gh` は自分のアカウントでログインしておきます。
> - systemd から起動したシェルの PATH は最小構成のため、`[Service]` に
>   `Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin` を追加してください。
> - ログアウト後もデーモンを動かし続けるには `loginctl enable-linger $USER` を実行します。

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
