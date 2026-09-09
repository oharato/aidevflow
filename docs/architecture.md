# aidevflow アーキテクチャ仕様書

## 1. 概要

`aidevflow` は、チーム開発プラットフォーム **Backlog** のプロジェクト配下にあるチケット（課題）状態の変化を検知し、人間の開発フローに沿った5つの専門 AI エージェント（**`agy` / Antigravity CLI**）を順次ディスパッチする自律型開発パイプラインの常駐デーモン（TypeScript）です。

### ワークスペース配置仕様（1チケット・複数リポジトリ共存対応）
1つのチケットで複数リポジトリ（例: フロントエンドとバックエンド）にまたがる改修が発生した場合でも衝突せず共存できるよう、**`~/aidevflow/worktrees/<issueKey>/<repoName>/`** の階層構造を採用しています：

```
~/aidevflow/
├── repos/
│   ├── <repoA>/              # 自動 clone / fetch された元リポジトリ A
│   └── <repoB>/              # 自動 clone / fetch された元リポジトリ B
└── worktrees/
    └── <issueKey>/           # チケット専用ルートディレクトリ
        ├── <repoA>/          # リポジトリ A の worktree (ブランチ: issueKey)
        └── <repoB>/          # リポジトリ B の worktree (ブランチ: issueKey)
```

- **作業ブランチ名**: チケットキー `<issueKey>`（例: `STUDY-3`）
- **エージェント実行環境**:
  - 単一リポジトリ時: `~/aidevflow/worktrees/<issueKey>/<repoName>/`
  - 複数リポジトリ時: `~/aidevflow/worktrees/<issueKey>/`（配下に全対象リポジトリの worktree が展開され、リポジトリ間を横断編集可能）
- **GitHub PR 作成**: 変更された各リポジトリごとに PR を自動作成し、Backlog に全 PR リンク一覧を自動コメント。

---

## 2. システム構成図

```mermaid
flowchart TD
    subgraph Backlog["Backlog (ohchans.backlog.jp / Project: STUDY)"]
        ProjectIssues["プロジェクト配下の課題群\n(STUDY-1, STUDY-2, STUDY-3 ...)\n詳細に1つまたは複数のリポジトリを記載"]
        ReviewComment["レビュー依頼コメント\n(複数PRリンク一覧 / 成果物要約)"]
    end

    subgraph Daemon["aidevflow TypeScript Daemon"]
        Poller["BacklogPoller\n(プロジェクト定期監視 / 状態検知)"]
        Dispatcher["AgentDispatcher\n(ステータス判定 & 振り分け)"]
        RepoParser["extractRepositoryPaths\n(チケット詳細から複数リポジトリ抽出)"]
        WorktreeMgr["GitWorktreeManager\n(複数リポジトリの clone & worktree 準備)"]
        GHService["GitHubService\n(複数リポジトリへの push & PR 作成)"]
        Reporter["Backlog 更新\n(ステータス更新 & レビュー依頼コメント投稿)"]
        Logger["JsonlLogger\n(構造化ログ出力)"]
    end

    subgraph AidevflowHome["aidevflow 起動ユーザー環境 (~/aidevflow/)"]
        Repos["~/aidevflow/repos/<repoName>\n(クローン元リポジトリ群)"]
        Worktrees["~/aidevflow/worktrees/<issueKey>/\n├── repoA/ (ブランチ: issueKey)\n└── repoB/ (ブランチ: issueKey)"]
    end

    subgraph GitHub["GitHub リモートリポジトリ群"]
        GitHubPRA["Pull Request A (repoA)\n[STUDY-3] タイトル"]
        GitHubPRB["Pull Request B (repoB)\n[STUDY-3] タイトル"]
    end

    subgraph Agents["5つの専門エージェント (Antigravity CLI: agy)"]
        Director["1. Director\n(詳細設計エージェント)"]
        Curator["2. Curator\n(詳細設計レビューエージェント)"]
        Artist["3. Artist\n(実装 & テスト & コミット)"]
        Critic["4. Critic\n(技術的レビュー: 静的解析/型/規約)"]
        Editor["5. Editor\n(要件的レビュー: 要件充足度)"]
    end

    ProjectIssues -->|"定期取得"| Poller
    Poller -->|"状態変更検知"| Dispatcher
    Dispatcher --> RepoParser
    RepoParser --> WorktreeMgr
    WorktreeMgr -->|"git clone / fetch"| Repos
    Repos -->|"git worktree add"| Worktrees

    Dispatcher -->|"CWD = ~/aidevflow/worktrees/STUDY-3"| Director
    Dispatcher -->|"CWD = ~/aidevflow/worktrees/STUDY-3"| Curator
    Dispatcher -->|"CWD = ~/aidevflow/worktrees/STUDY-3"| Artist
    Dispatcher -->|"CWD = ~/aidevflow/worktrees/STUDY-3"| Critic
    Dispatcher -->|"CWD = ~/aidevflow/worktrees/STUDY-3"| Editor

    Artist -->|"実装・コミット完了"| GHService
    GHService -->|"git push & gh pr create"| GitHubPRA
    GHService -->|"git push & gh pr create"| GitHubPRB
    GitHubPRA -.->|"PR URL 返却"| Dispatcher
    GitHubPRB -.->|"PR URL 返却"| Dispatcher

    Editor -->|"全工程完了 (承認)"| Reporter
    Reporter -->|"PRリンク一覧付きレビュー依頼コメント"| ReviewComment
    ReviewComment --> ProjectIssues

    Dispatcher -.->|"イベント記録"| Logger
    Logger --> JSONLFile["logs/aidevflow.jsonl"]
```

---

## 3. チケット詳細からの複数リポジトリ指定記法

チケットの「詳細（description）」に、以下のように箇条書きまたはカンマ区切りで複数のリポジトリを記載できます：

```markdown
【対象リポジトリ】
リポジトリ:
- https://github.com/my-org/frontend.git
- https://github.com/my-org/backend.git

【要件】
APIエンドポイントを追加し、UI側でデータを表示する。
```

デーモンは両方のリポジトリを自動でクローンし、
- `~/aidevflow/worktrees/STUDY-3/frontend/`
- `~/aidevflow/worktrees/STUDY-3/backend/`
を準備してエージェントに渡します。
エージェントは両リポジトリのコードを同時に確認・修正可能です。

---

## 4. Backlog レビュー依頼コメント仕様（複数PR対応）

```markdown
### 🚀 【レビュー依頼】AIエージェントによる全工程が完了しました

チケット **STUDY-3: ユーザー管理機能の追加** に対するすべての開発工程（詳細設計 → 設計レビュー → 実装 → 技術レビュー → 要件レビュー）が完了しました。

以下のプルリクエストをご確認の上、レビュー・マージをお願いいたします。

- 🔗 **GitHub プルリクエスト一覧**:
  - **frontend**: https://github.com/my-org/frontend/pull/45
  - **backend**: https://github.com/my-org/backend/pull/82
- **ブランチ**: `STUDY-3`
- **作業 Worktree**: `/home/oharato/aidevflow/worktrees/STUDY-3`
- **ステータス**: 完了

#### 最終要件レビュー報告:
フロントエンド・バックエンド両方の実装が受け入れ要件を満たしていることを確認しました（LGTM）。
```

---

## 5. 差し戻し無限ループ防止 & 人間エスカレーション仕様

### 状態遷移と人間介入ポイント

```mermaid
stateDiagram-v2
    [*] --> 詳細設計中: チケット作成 / 開始
    詳細設計中 --> 設計レビュー中: director完了
    
    設計レビュー中 --> 実装中: curator承認 (LGTM)
    設計レビュー中 --> 詳細設計中: curator差し戻し (リトライ < 上限)

    実装中 --> 技術レビュー中: artist実装・コミット完了
    技術レビュー中 --> 要件レビュー中: critic承認 (LGTM)
    技術レビュー中 --> 実装中: critic差し戻し (リトライ < 上限)

    要件レビュー中 --> 完了: editor承認 (全工程完了)
    要件レビュー中 --> 実装中: editor差し戻し (リトライ < 上限)

    %% 人間介入 (エスカレーション)
    設計レビュー中 --> 確認待ち: 差し戻し上限到達 or 質問発生
    技術レビュー中 --> 確認待ち: 差し戻し上限到達 or 質問発生
    要件レビュー中 --> 確認待ち: 差し戻し上限到達 or 質問発生
    詳細設計中 --> 確認待ち: 判断不能な論点発生
    実装中 --> 確認待ち: 判断不能な論点発生

    確認待ち --> 詳細設計中: 人間が回答コメント & ステータス戻し
    確認待ち --> 実装中: 人間が回答コメント & ステータス戻し

    完了 --> [*]: 人間による最終確認 & マージ
```

### 仕様詳細

1. **差し戻し回数上限制御 (`MAX_REJECTION_COUNT`)**:
   - チケットごとの連続差し戻し回数をデーモンメモリ上で追跡。
   - 上限回数（デフォルト: `3` 回）に達すると、ステータスを **「確認待ち」** (`#f42858` 赤) に変更し、ループ停止理由と現状の論点を整理したコメントを投稿してパイプラインを安全に一時停止します。
   - 各レビューで承認（LGTM）された場合はカウンターが自動リセットされます。

2. **エージェントからの自律解決不能エスカレーション**:
   - 仕様の矛盾や複数のアーキテクチャ選択肢など、AI単独で判断できない要件に直面した場合、エージェントはプロンプトの指示に従って `【人間への確認依頼】` または `CONFIRM_HUMAN` タグ付きで論点を出力します。
   - デーモンはこのタグを検知すると、差し戻し回数に関わらず即座にステータスを **「確認待ち」** に移行します。

3. **人間介入後の再開フロー (Resume)**:
   - 人間が Backlog チケットに回答コメント（指示・仕様の決定）を投稿し、ステータスを「詳細設計中」または「実装中」に戻します。
   - デーモン（`BacklogPoller`）が「確認待ち」からのステータス変更を自動検知し、**差し戻しカウンターをゼロにリセット** します。
   - エージェントは人間の最新コメントを最優先コンテキストとして自律作業を再開します。

