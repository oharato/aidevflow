import type { WorkflowDefinition, WorkflowStep } from "../../workflow/types.js";
import type {
  IIssueTracker,
  TrackedIssue,
  IssueLifecycleState,
  IssueFilterOptions,
  StepTransitionOptions,
  LifecycleTransitionOptions,
} from "../types.js";

/**
 * テスト・オフライン検証用のインメモリ Mock トラッカー
 */
export class MockIssueTracker implements IIssueTracker {
  readonly trackerType = "mock";

  private issues: Map<string, TrackedIssue> = new Map();
  private commentHistory: Map<string, string[]> = new Map();
  public stepTransitions: Array<{ key: string; nextStep: WorkflowStep }> = [];
  public lifecycleTransitions: Array<{ key: string; state: IssueLifecycleState }> = [];

  /**
   * テスト用初期チケットの登録
   */
  addMockIssue(
    issue: Partial<TrackedIssue> & { key: string; title: string }
  ): TrackedIssue {
    const fullIssue: TrackedIssue = {
      id: issue.id || Math.floor(Math.random() * 10000),
      rawTitle: issue.rawTitle || issue.title,
      description: issue.description || "",
      currentStepName: issue.currentStepName,
      currentStepDef: issue.currentStepDef,
      lifecycleState: issue.lifecycleState || "ready",
      rawStatusName: issue.rawStatusName || (issue.lifecycleState === "in_progress" ? "処理中" : "未対応"),
      recentComments: issue.recentComments || [],
      issueType: issue.issueType || "タスク",
      categories: issue.categories || [],
      isInvestigation: issue.isInvestigation ?? false,
      isFastMode: issue.isFastMode ?? false,
      updatedAt: issue.updatedAt || new Date().toISOString(),
      ...issue,
      key: issue.key,
      title: issue.title,
    };
    this.issues.set(issue.key, fullIssue);
    return fullIssue;
  }

  async init(): Promise<void> {
    // インメモリのため即時完了
  }

  async fetchActionableIssues(
    workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]> {
    return Array.from(this.issues.values()).filter((issue) => {
      // 1. 種別フィルタ
      if (filter?.targetIssueType && issue.issueType !== filter.targetIssueType) {
        return false;
      }

      // 2. カテゴリーフィルタ
      if (filter?.targetCategory) {
        const hasCat = issue.categories?.includes(filter.targetCategory);
        if (!hasCat) return false;
      }

      // 3. [AI] タグ必須フィルタ
      if (filter?.requireAiTag && !/\[AI\]/i.test(issue.title)) {
        return false;
      }

      // 自律実行が進行可能（進行中 かつ 担当ステップが定義に存在）なチケットのみ抽出
      if (issue.lifecycleState !== "in_progress") {
        return false;
      }

      if (!issue.currentStepName) {
        return false;
      }

      return Boolean(workflowDef.steps[issue.currentStepName]);
    });
  }

  async fetchCandidateIssues(
    _workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]> {
    return Array.from(this.issues.values()).filter((issue) => {
      if (filter?.targetIssueType && issue.issueType !== filter.targetIssueType) {
        return false;
      }
      if (filter?.targetCategory) {
        const hasCat = issue.categories?.includes(filter.targetCategory);
        if (!hasCat) return false;
      }
      if (filter?.requireAiTag && !/\[AI\]/i.test(issue.title)) {
        return false;
      }
      return true;
    });
  }

  async getIssue(key: string, _workflowDef?: WorkflowDefinition): Promise<TrackedIssue> {
    const issue = this.issues.get(key);
    if (!issue) {
      throw new Error(`[MockIssueTracker] チケット "${key}" が見つかりません`);
    }
    return { ...issue };
  }

  async updateIssueStep(
    key: string,
    nextStep: WorkflowStep,
    options: StepTransitionOptions = {}
  ): Promise<void> {
    const issue = this.issues.get(key);
    if (!issue) {
      throw new Error(`[MockIssueTracker] チケット "${key}" が見つかりません`);
    }

    this.stepTransitions.push({ key, nextStep });
    issue.currentStepName = nextStep.name;
    issue.currentStepDef = nextStep;
    issue.lifecycleState = "in_progress";
    issue.rawStatusName = "処理中";
    issue.rawTitle = options.newSummary || `${nextStep.backlog_tag} ${issue.title}`;
    issue.updatedAt = new Date().toISOString();

    if (options.comment) {
      this.recordComment(key, options.comment);
    }
  }

  async updateLifecycle(
    key: string,
    state: IssueLifecycleState,
    options: LifecycleTransitionOptions = {}
  ): Promise<void> {
    const issue = this.issues.get(key);
    if (!issue) {
      throw new Error(`[MockIssueTracker] チケット "${key}" が見つかりません`);
    }

    this.lifecycleTransitions.push({ key, state });
    issue.lifecycleState = state;
    issue.updatedAt = new Date().toISOString();

    switch (state) {
      case "waiting_confirmation":
        issue.rawStatusName = "未対応";
        issue.rawTitle = options.newSummary || `[確認待ち] ${issue.title}`;
        break;
      case "waiting_approval":
        issue.rawStatusName = "未対応";
        issue.rawTitle = options.newSummary || `[設計承認待ち] ${issue.title}`;
        break;
      case "completed":
        issue.rawStatusName = "処理済み";
        issue.rawTitle = options.newSummary || `[要件レビュー完了] ${issue.title}`;
        break;
      case "in_progress":
        issue.rawStatusName = "処理中";
        break;
      case "ready":
        issue.rawStatusName = "未対応";
        break;
    }

    if (options.comment) {
      this.recordComment(key, options.comment);
    }
  }

  async addComment(key: string, content: string): Promise<void> {
    this.recordComment(key, content);
  }

  async getRecentComments(key: string, limit: number = 10): Promise<string[]> {
    const issue = this.issues.get(key);
    if (issue && issue.recentComments.length > 0) {
      return issue.recentComments.slice(-limit);
    }
    const history = this.commentHistory.get(key) || [];
    return history.slice(-limit);
  }

  isCustomStatusMode(): boolean {
    return false;
  }

  async fetchCompletedIssues(): Promise<TrackedIssue[]> {
    return Array.from(this.issues.values()).filter(
      (i) => i.lifecycleState === "completed"
    );
  }

  /**
   * テスト検証用: チケットに投稿された全コメント履歴を取得
   */
  getPostedComments(key: string): string[] {
    return this.commentHistory.get(key) || [];
  }

  private recordComment(key: string, comment: string): void {
    const history = this.commentHistory.get(key) || [];
    history.push(comment);
    this.commentHistory.set(key, history);

    const issue = this.issues.get(key);
    if (issue) {
      issue.recentComments.unshift(comment);
    }
  }
}
