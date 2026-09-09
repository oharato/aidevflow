import type {
  BacklogIssue,
  BacklogStatus,
  BacklogComment,
  BacklogProject,
  GetIssuesParams,
} from "./types.js";

export class BacklogClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(spaceId: string, domain: string = "backlog.jp", apiKey: string) {
    this.baseUrl = `https://${spaceId}.${domain}/api/v2`;
    this.apiKey = apiKey;
  }

  private getAuthQuery(): string {
    return `apiKey=${encodeURIComponent(this.apiKey)}`;
  }

  async getProject(projectIdOrKey: string | number): Promise<BacklogProject> {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(projectIdOrKey)}?${this.getAuthQuery()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] GET /projects/${projectIdOrKey}: ${errText}`);
    }
    return (await res.json()) as BacklogProject;
  }

  async getIssue(issueIdOrKey: string): Promise<BacklogIssue> {
    const url = `${this.baseUrl}/issues/${encodeURIComponent(issueIdOrKey)}?${this.getAuthQuery()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] GET /issues/${issueIdOrKey}: ${errText}`);
    }
    return (await res.json()) as BacklogIssue;
  }

  async getIssues(params: GetIssuesParams): Promise<BacklogIssue[]> {
    const query = new URLSearchParams();
    query.append("apiKey", this.apiKey);

    if (params.projectId && params.projectId.length > 0) {
      for (const pid of params.projectId) {
        query.append("projectId[]", String(pid));
      }
    }
    if (params.statusId && params.statusId.length > 0) {
      for (const sid of params.statusId) {
        query.append("statusId[]", String(sid));
      }
    }
    if (params.count) {
      query.append("count", String(params.count));
    }
    if (params.sort) {
      query.append("sort", params.sort);
    }
    if (params.order) {
      query.append("order", params.order);
    }

    const url = `${this.baseUrl}/issues?${query.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] GET /issues: ${errText}`);
    }
    return (await res.json()) as BacklogIssue[];
  }

  async getProjectStatuses(projectIdOrKey: string | number): Promise<BacklogStatus[]> {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(projectIdOrKey)}/statuses?${this.getAuthQuery()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] GET /projects/${projectIdOrKey}/statuses: ${errText}`);
    }
    return (await res.json()) as BacklogStatus[];
  }

  async addStatus(
    projectIdOrKey: string | number,
    name: string,
    color: string
  ): Promise<BacklogStatus> {
    const url = `${this.baseUrl}/projects/${encodeURIComponent(projectIdOrKey)}/statuses?${this.getAuthQuery()}`;
    const body = new URLSearchParams();
    body.append("name", name);
    body.append("color", color);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] POST /projects/${projectIdOrKey}/statuses: ${errText}`);
    }
    return (await res.json()) as BacklogStatus;
  }

  async updateIssue(
    issueIdOrKey: string,
    params: import("./types.js").UpdateIssueParams
  ): Promise<BacklogIssue> {
    const url = `${this.baseUrl}/issues/${encodeURIComponent(issueIdOrKey)}?${this.getAuthQuery()}`;
    const body = new URLSearchParams();
    if (params.summary !== undefined) {
      body.append("summary", params.summary);
    }
    if (params.statusId !== undefined) {
      body.append("statusId", String(params.statusId));
    }
    if (params.comment !== undefined) {
      body.append("comment", params.comment);
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] PATCH /issues/${issueIdOrKey}: ${errText}`);
    }
    return (await res.json()) as BacklogIssue;
  }

  async updateIssueStatus(
    issueIdOrKey: string,
    statusId: number,
    comment?: string
  ): Promise<BacklogIssue> {
    return this.updateIssue(issueIdOrKey, { statusId, comment });
  }

  async addComment(issueIdOrKey: string, content: string): Promise<BacklogComment> {
    const url = `${this.baseUrl}/issues/${encodeURIComponent(issueIdOrKey)}/comments?${this.getAuthQuery()}`;
    const body = new URLSearchParams();
    body.append("content", content);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] POST /issues/${issueIdOrKey}/comments: ${errText}`);
    }
    return (await res.json()) as BacklogComment;
  }

  async getComments(issueIdOrKey: string, count: number = 20): Promise<BacklogComment[]> {
    const url = `${this.baseUrl}/issues/${encodeURIComponent(issueIdOrKey)}/comments?${this.getAuthQuery()}&count=${count}&order=desc`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Backlog API Error [${res.status}] GET /issues/${issueIdOrKey}/comments: ${errText}`);
    }
    return (await res.json()) as BacklogComment[];
  }
}
