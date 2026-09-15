import type { BacklogClient } from "../../backlog/client.js";
import type { BacklogIssue, BacklogStatus, GetIssuesParams } from "../../backlog/types.js";
import { sanitizeBacklogText } from "../../backlog/client.js";
import {
  hasCustomStatuses,
  stripPhasePrefix,
  formatSummaryWithPhase,
  PHASE_TAGS,
  isInvestigationIssue,
  isFastModeIssue,
} from "../../backlog/prefix-helper.js";
import type { WorkflowDefinition, WorkflowStep } from "../../workflow/types.js";
import type {
  IIssueTracker,
  TrackedIssue,
  IssueLifecycleState,
  IssueFilterOptions,
  StepTransitionOptions,
  LifecycleTransitionOptions,
} from "../types.js";

export interface BacklogTrackerOptions {
  client: BacklogClient;
  projectKey: string;
  customStatusModeOverride?: boolean;
}

/**
 * Backlog を BTS として扱うアダプタークラス
 * 宣言的ワークフロー定義（WorkflowDefinition）に基づき、
 * チケットのステップ検知やステータス・件名プレフィックス更新を行う
 */
export class BacklogTracker implements IIssueTracker {
  readonly trackerType = "backlog";

  private client: BacklogClient;
  private projectKey: string;
  private projectId: number | null = null;
  private projectStatuses: BacklogStatus[] = [];
  private isCustomMode: boolean = false;
  private customStatusModeOverride?: boolean;
  /** API キー所有者（自分）の Backlog ユーザーID。onlyAssignedToMe 使用時に遅延取得してキャッシュ */
  private myUserId: number | null = null;
  private myUserName: string | null = null;

  constructor(options: BacklogTrackerOptions) {
    this.client = options.client;
    this.projectKey = options.projectKey;
    this.customStatusModeOverride = options.customStatusModeOverride;
    if (options.customStatusModeOverride !== undefined) {
      this.isCustomMode = options.customStatusModeOverride;
    }
  }

  getClient(): BacklogClient {
    return this.client;
  }

  getProjectKey(): string {
    return this.projectKey;
  }

  getProjectId(): number | null {
    return this.projectId;
  }

  getProjectStatuses(): BacklogStatus[] {
    return [...this.projectStatuses];
  }

  setProjectStatuses(statuses: Array<{ id?: number | string; name: string } | unknown>): void {
    this.projectStatuses = statuses as BacklogStatus[];
    if (this.customStatusModeOverride === undefined) {
      this.isCustomMode = hasCustomStatuses(this.projectStatuses);
    }
  }

  isCustomStatusMode(): boolean {
    return this.isCustomMode;
  }

  async init(): Promise<void> {
    const project = await this.client.getProject(this.projectKey);
    this.projectId = project.id;
    this.projectStatuses = await this.client.getProjectStatuses(project.id);
    this.isCustomMode =
      this.customStatusModeOverride !== undefined
        ? this.customStatusModeOverride
        : hasCustomStatuses(this.projectStatuses);
  }

  /**
   * API キー所有者（自分）のユーザー情報を取得してキャッシュする
   * 個人用デーモン運用（ONLY_ASSIGNED_TO_ME=true）で担当者フィルタの基準にする
   */
  async resolveMyself(): Promise<{ id: number; name: string }> {
    if (this.myUserId !== null) {
      return { id: this.myUserId, name: this.myUserName || "" };
    }
    if (typeof this.client.getMyself !== "function") {
      throw new Error(
        "[BacklogTracker] onlyAssignedToMe を使うには BacklogClient.getMyself() が必要です"
      );
    }
    const me = await this.client.getMyself();
    this.myUserId = me.id;
    this.myUserName = me.name;
    return { id: me.id, name: me.name };
  }

  getMyUserId(): number | null {
    return this.myUserId;
  }

  /**
   * 状態追跡・スキャン対象の候補チケット一覧を取得 (非アクション対象も含む)
   */
  async fetchCandidateIssues(
    workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]> {
    if (!this.projectId) {
      await this.init();
    }

    // 担当者フィルタ: API 側 (assigneeId[]) と取得後の二重チェックで他人のチケットを除外
    let myId: number | null = null;
    if (filter?.onlyAssignedToMe) {
      myId = (await this.resolveMyself()).id;
    }

    // クローズ済み（完了）ステータスは監視対象外なので API 側で除外し、取得件数を抑える
    const openStatusIds = this.projectStatuses
      .filter((st) => !this.isClosedStatusName(st.name))
      .map((st) => st.id);

    const rawIssues = await this.fetchAllOpenIssues({
      projectId: [this.projectId!],
      ...(myId !== null ? { assigneeId: [myId] } : {}),
      ...(openStatusIds.length > 0 ? { statusId: openStatusIds } : {}),
    });

    const candidates: TrackedIssue[] = [];

    for (const raw of rawIssues) {
      // 0. 担当者フィルタ (API 側で絞れなかった場合の保険)
      if (myId !== null && raw.assignee?.id !== myId) {
        continue;
      }

      if (!this.matchesStaticFilter(raw, filter)) {
        continue;
      }

      candidates.push(this.toTrackedIssue(raw, workflowDef));
    }

    return candidates;
  }

  /**
   * 更新日時の新しい順にページングして全件取得する。
   * 旧実装は「更新が古い順に 50 件固定」だったため、課題が 50 件を超えるプロジェクトでは
   * 直近に「処理中」へ変更されたチケットが取得窓の外に出て永遠に検知されなかった。
   */
  private async fetchAllOpenIssues(
    baseParams: Pick<GetIssuesParams, "projectId" | "assigneeId" | "statusId">
  ): Promise<BacklogIssue[]> {
    const pageSize = 100;
    const maxPages = 5;
    const seen = new Set<number>();
    const all: BacklogIssue[] = [];

    for (let page = 0; page < maxPages; page++) {
      const batch = await this.client.getIssues({
        ...baseParams,
        sort: "updated",
        order: "desc",
        count: pageSize,
        offset: page * pageSize,
      });
      let added = 0;
      for (const raw of batch) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        all.push(raw);
        added++;
      }
      // 最終ページ、または（モック等で）同じ内容が返り続ける場合は終了
      if (batch.length < pageSize || added === 0) break;
    }

    return all;
  }

  /**
   * 種別・カテゴリー・[AI] タグの静的フィルタ判定
   */
  private matchesStaticFilter(raw: BacklogIssue, filter?: IssueFilterOptions): boolean {
    if (filter?.targetIssueType && raw.issueType?.name !== filter.targetIssueType) {
      return false;
    }
    if (filter?.targetCategory) {
      const hasCat = raw.category?.some((c) => c.name === filter.targetCategory);
      if (!hasCat) return false;
    }
    if (filter?.requireAiTag && !/\[AI\]/i.test(raw.summary)) {
      return false;
    }
    return true;
  }

  /**
   * 単一チケットがフィルタ条件を満たすか（BACKLOG_ISSUE_KEY 単一監視モード用）
   */
  async isIssueEligible(issue: TrackedIssue, filter?: IssueFilterOptions): Promise<boolean> {
    if (!filter) return true;
    if (filter.onlyAssignedToMe) {
      const me = await this.resolveMyself();
      if (issue.assigneeId !== me.id) return false;
    }
    if (filter.targetIssueType && issue.issueType !== filter.targetIssueType) return false;
    if (filter.targetCategory && !issue.categories?.includes(filter.targetCategory)) return false;
    if (filter.requireAiTag && !/\[AI\]/i.test(issue.rawTitle)) return false;
    return true;
  }

  /**
   * 「完了」「Closed」等、人間がクローズ済みとみなすステータス名か判定する
   * （「処理済み」= AI 全工程完了・人間レビュー待ち はクローズではない）
   */
  isClosedStatusName(statusName: string): boolean {
    const norm = (statusName || "").trim().toLowerCase();
    if (!norm) return false;
    if (norm.includes("処理済")) return false;
    return (
      norm === "完了" ||
      norm === "closed" ||
      norm === "complete" ||
      norm === "completed" ||
      norm.endsWith("完了")
    );
  }

  /**
   * 着手可能なチケットを取得
   */
  async fetchActionableIssues(
    workflowDef: WorkflowDefinition,
    filter?: IssueFilterOptions
  ): Promise<TrackedIssue[]> {
    const candidates = await this.fetchCandidateIssues(workflowDef, filter);
    return candidates.filter(
      (tracked) => tracked.lifecycleState === "in_progress" && Boolean(tracked.currentStepName)
    );
  }

  /**
   * 特定チケットを取得
   */
  async getIssue(key: string, workflowDef?: WorkflowDefinition): Promise<TrackedIssue> {
    const raw = await this.client.getIssue(key);
    return this.toTrackedIssue(raw, workflowDef);
  }

  /**
   * 次のワークフローステップへ更新
   */
  async updateIssueStep(
    key: string,
    nextStep: WorkflowStep,
    options: StepTransitionOptions = {}
  ): Promise<void> {
    const comment = options.comment;

    if (this.isCustomMode) {
      const targetStatusId = this.findStatusIdByName(nextStep.custom_status);
      if (targetStatusId) {
        if (typeof this.client.updateIssue === "function") {
          await this.client.updateIssue(key, { statusId: targetStatusId, comment });
        } else if (typeof this.client.updateIssueStatus === "function") {
          await this.client.updateIssueStatus(key, targetStatusId, comment);
        } else if (comment && typeof this.client.addComment === "function") {
          await this.client.addComment(key, comment);
        }
        return;
      }
    }

    // 件名プレフィックスモード
    let cleanTitle = key;
    if (typeof this.client.getIssue === "function") {
      try {
        const raw = await this.client.getIssue(key);
        if (raw?.summary) cleanTitle = stripPhasePrefix(raw.summary);
      } catch {
        // ignore
      }
    }
    const tag = nextStep.backlog_tag ? nextStep.backlog_tag.replace(/^\[|\]$/g, "") : nextStep.name;
    const newSummary = options.newSummary || formatSummaryWithPhase(cleanTitle, tag);
    const inProgressStatusId = this.findStatusIdByName("処理中") || 2;

    if (typeof this.client.updateIssue === "function") {
      await this.client.updateIssue(key, {
        summary: sanitizeBacklogText(newSummary),
        statusId: inProgressStatusId,
        comment,
      });
    } else if (typeof this.client.updateIssueStatus === "function") {
      await this.client.updateIssueStatus(key, inProgressStatusId, comment);
    } else if (comment && typeof this.client.addComment === "function") {
      await this.client.addComment(key, comment);
    }
  }

  /**
   * ライフサイクル状態の更新
   */
  async updateLifecycle(
    key: string,
    state: IssueLifecycleState,
    options: LifecycleTransitionOptions = {}
  ): Promise<void> {
    const comment = options.comment;
    let cleanTitle = key;
    let isInvestigation = false;

    if (typeof this.client.getIssue === "function") {
      try {
        const raw = await this.client.getIssue(key);
        if (raw?.summary) {
          cleanTitle = stripPhasePrefix(raw.summary);
          isInvestigation = isInvestigationIssue(raw);
        }
      } catch {
        // ignore
      }
    }

    let targetStatusId: number | null = null;
    let targetSummary: string | undefined = options.newSummary;

    switch (state) {
      case "waiting_confirmation": {
        // カスタム状態モードでも「確認待ち」が未登録なら、件名タグ + 未対応 にフォールバックして
        // 必ず「進行中でない」終端状態に落とす（コメントだけ投稿して処理中のまま残すとループする）
        const confirmId = this.isCustomMode ? this.findStatusIdByName("確認待ち") : null;
        if (confirmId) {
          targetStatusId = confirmId;
        } else {
          targetSummary = targetSummary || formatSummaryWithPhase(cleanTitle, PHASE_TAGS.confirmHuman);
          targetStatusId = this.findStatusIdByName("未対応") || 1;
        }
        break;
      }
      case "waiting_approval": {
        const confirmId = this.isCustomMode ? this.findStatusIdByName("確認待ち") : null;
        if (confirmId) {
          targetStatusId = confirmId;
        } else {
          // 人間の設計承認待ち (プレフィックスモード / 確認待ち未登録時のフォールバック)
          targetSummary = targetSummary || formatSummaryWithPhase(cleanTitle, PHASE_TAGS.specApprovalWait);
          targetStatusId = this.findStatusIdByName("未対応") || 1;
        }
        break;
      }
      case "completed": {
        if (this.isCustomMode) {
          targetStatusId = this.findStatusIdByName("完了") || this.findStatusIdByName("処理済み");
        } else {
          const completedTag = isInvestigation
            ? PHASE_TAGS.investigationCompleted
            : PHASE_TAGS.completed;
          targetSummary = targetSummary || formatSummaryWithPhase(cleanTitle, completedTag);
          targetStatusId = this.findStatusIdByName("処理済み") || 3;
        }
        break;
      }
      case "closed": {
        targetStatusId = this.findStatusIdByName("完了") || 4;
        break;
      }
      case "in_progress": {
        targetStatusId = this.findStatusIdByName("処理中") || 2;
        break;
      }
      case "ready": {
        targetStatusId = this.findStatusIdByName("未対応") || 1;
        break;
      }
    }

    const params: { summary?: string; statusId?: number; comment?: string } = {};
    if (targetSummary) params.summary = sanitizeBacklogText(targetSummary);
    if (targetStatusId) params.statusId = targetStatusId;
    if (comment) params.comment = comment;

    if (typeof this.client.updateIssue === "function") {
      await this.client.updateIssue(key, params);
    } else if (params.statusId && typeof this.client.updateIssueStatus === "function") {
      await this.client.updateIssueStatus(key, params.statusId, comment);
    } else if (comment && typeof this.client.addComment === "function") {
      await this.client.addComment(key, comment);
    }
  }

  /**
   * コメント投稿
   */
  async addComment(key: string, content: string): Promise<void> {
    await this.client.addComment(key, sanitizeBacklogText(content));
  }

  /**
   * チケットの最近のコメント履歴（テキスト配列）を取得する
   */
  async getRecentComments(key: string, limit: number = 10): Promise<string[]> {
    try {
      let rawList: Array<{ content?: string; createdUser?: { name?: string } }> = [];
      const clientAny = this.client as unknown as Record<string, unknown>;
      if (typeof this.client.getComments === "function") {
        rawList = await this.client.getComments(key, limit);
      } else if (typeof clientAny.getIssueComments === "function") {
        rawList = await (clientAny.getIssueComments as (k: string) => Promise<typeof rawList>)(key);
      }
      return rawList
        .filter((c) => Boolean(c.content && c.content.trim().length > 0))
        .map((c) => {
          let text = (c.content || "").trim();
          if (text.includes('{"event":') || text.includes('"step_update":')) {
            text = "[システムログのため省略]";
          } else if (text.length > 1500) {
            text = text.slice(0, 1500) + "\n...[長文のため一部省略]...";
          }
          return `[${c.createdUser?.name || "User"}]: ${text}`;
        })
        .slice(-limit);
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * リソースクリーンアップ用の完了チケット一覧を取得
   */
  async fetchCompletedIssues(): Promise<TrackedIssue[]> {
    if (!this.projectId) {
      await this.init();
    }

    const rawIssues = await this.client.getIssues({
      projectId: [this.projectId!],
      sort: "updated",
      order: "desc",
      count: 100,
    });

    // クリーンアップ対象は人間がクローズした「完了」ステータスのみ
    // （「処理済み」や [要件レビュー完了] タグは人間の PR レビュー待ちなので対象外）
    const completed: TrackedIssue[] = [];
    for (const raw of rawIssues) {
      if (this.isClosedStatusName(raw.status?.name || "")) {
        completed.push(this.toTrackedIssue(raw));
      }
    }

    return completed;
  }

  findStatusIdByName(targetName: string): number | null {
    const targetLower = targetName.toLowerCase();
    const exact = this.projectStatuses.find((st) => st.name.toLowerCase() === targetLower);
    if (exact) return exact.id;

    const partial = this.projectStatuses.find((st) => st.name.toLowerCase().includes(targetLower));
    if (partial) return partial.id;

    return null;
  }

  /**
   * BacklogIssue を TrackedIssue に変換する
   */
  private toTrackedIssue(raw: BacklogIssue, workflowDef?: WorkflowDefinition): TrackedIssue {
    const cleanTitle = stripPhasePrefix(raw.summary);
    const isInvestigation = isInvestigationIssue(raw);
    const isFastMode = isFastModeIssue(raw);

    const { stepName, stepDef, lifecycleState } = this.resolveStepAndLifecycle(
      raw,
      workflowDef,
      isInvestigation,
      isFastMode
    );

    return {
      key: raw.issueKey,
      id: raw.id,
      title: cleanTitle,
      rawTitle: raw.summary,
      description: raw.description || "",
      currentStepName: stepName,
      currentStepDef: stepDef,
      lifecycleState,
      rawStatusName: raw.status.name,
      recentComments: [],
      issueType: raw.issueType?.name,
      categories: raw.category?.map((c) => c.name),
      assigneeId: raw.assignee?.id,
      assigneeName: raw.assignee?.name,
      isInvestigation,
      isFastMode,
      updatedAt: raw.updated || raw.created,
    };
  }

  /**
   * ステップとライフサイクルの動的解決
   */
  private resolveStepAndLifecycle(
    issue: BacklogIssue,
    workflowDef?: WorkflowDefinition,
    isInvestigation?: boolean,
    isFastMode?: boolean
  ): {
    stepName?: string;
    stepDef?: WorkflowStep;
    lifecycleState: IssueLifecycleState;
  } {
    const statusName = issue.status.name;
    const summary = issue.summary;

    // 1. 人間確認待ち
    if (statusName.includes("確認待ち") || summary.includes("[確認待ち]")) {
      // プレフィックスモードで、人間が「処理中」に変更して再開を指示した場合
      if (summary.includes("[確認待ち]") && statusName.includes("処理中")) {
        const resumeStepName = isFastMode && workflowDef?.steps["developer"]
          ? "developer"
          : (workflowDef?.initial_step || "spec-writer");
        const resumeStep = workflowDef?.steps[resumeStepName];
        return {
          stepName: resumeStep?.name || resumeStepName,
          stepDef: resumeStep,
          lifecycleState: "in_progress",
        };
      }
      return { lifecycleState: "waiting_confirmation" };
    }

    // 2. 人間設計承認待ち
    if (summary.includes("[設計承認待ち]")) {
      if (statusName.includes("未対応")) {
        return { lifecycleState: "waiting_approval" };
      }
      // 人間が承認して「処理中」にした場合
      if (statusName.includes("処理中")) {
        const devStep = workflowDef?.steps["developer"];
        return {
          stepName: devStep?.name || "developer",
          stepDef: devStep,
          lifecycleState: "in_progress",
        };
      }
    }

    // 3. 完了状態
    if (
      statusName.includes("完了") ||
      statusName.includes("処理済み") ||
      summary.includes("[完了]") ||
      summary.includes("[要件レビュー完了]") ||
      summary.includes("[調査完了]")
    ) {
      if (statusName.includes("処理中")) {
        // 人間レビュー後の差し戻しで「処理中」に戻された場合
        const resumeStep = isInvestigation ? "spec-writer" : "developer";
        const stepDef = workflowDef?.steps[resumeStep];
        return {
          stepName: stepDef?.name || resumeStep,
          stepDef,
          lifecycleState: "in_progress",
        };
      }
      // 「完了」(人間がクローズ) と「処理済み」(AI 完了・人間レビュー待ち) を区別する
      if (this.isClosedStatusName(statusName)) {
        return { lifecycleState: "closed" };
      }
      return { lifecycleState: "completed" };
    }

    // 4. 未対応 (初期状態)
    if (statusName.includes("未対応")) {
      return { lifecycleState: "ready" };
    }

    // 5. 進行中 (処理中 または カスタム状態)
    if (workflowDef) {
      // 5-1. カスタム状態モード
      if (this.isCustomMode) {
        for (const step of Object.values(workflowDef.steps)) {
          if (
            step.custom_status &&
            statusName.toLowerCase().includes(step.custom_status.toLowerCase())
          ) {
            return {
              stepName: step.name,
              stepDef: step,
              lifecycleState: "in_progress",
            };
          }
        }
      }

      // 5-2. 件名プレフィックスモード
      for (const step of Object.values(workflowDef.steps)) {
        if (step.backlog_tag && summary.includes(step.backlog_tag)) {
          return {
            stepName: step.name,
            stepDef: step,
            lifecycleState: "in_progress",
          };
        }
      }

      // 5-3. タグなしで「処理中」の場合の初期ステップ
      if (statusName.includes("処理中")) {
        const initialStepName = isFastMode && workflowDef.steps["developer"]
          ? "developer"
          : workflowDef.initial_step;
        const initialStep = workflowDef.steps[initialStepName];
        return {
          stepName: initialStep?.name || initialStepName,
          stepDef: initialStep,
          lifecycleState: "in_progress",
        };
      }
    }

    return { lifecycleState: "ready" };
  }
}
