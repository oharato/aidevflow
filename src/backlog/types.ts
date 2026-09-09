export interface BacklogStatus {
  id: number;
  projectId: number;
  name: string;
  color: string;
  displayOrder: number;
}

export interface BacklogUser {
  id: number;
  name: string;
  roleType?: number;
  lang?: string;
  mailAddress?: string;
}

export interface BacklogComment {
  id: number;
  content: string;
  createdUser: BacklogUser;
  created: string;
  updated: string;
}

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
  chartEnabled: boolean;
  subtaskingEnabled: boolean;
  projectLeaderCanEditProjectLeader: boolean;
  useWiki: boolean;
  useFileSharing: boolean;
  useWikiTreeView: boolean;
  archived: boolean;
}

export interface BacklogIssue {
  id: number;
  projectId: number;
  issueKey: string;
  keyId: number;
  issueType: {
    id: number;
    name: string;
  };
  category?: Array<{
    id: number;
    name: string;
  }>;
  summary: string;
  description: string;
  status: BacklogStatus;
  assignee?: BacklogUser | null;
  createdUser: BacklogUser;
  created: string;
  updated: string;
}

export interface GetIssuesParams {
  projectId?: number[];
  statusId?: number[];
  issueTypeId?: number[];
  categoryId?: number[];
  count?: number;
  order?: "asc" | "desc";
  sort?: "updated" | "created";
}

export interface UpdateIssueParams {
  summary?: string;
  statusId?: number;
  comment?: string;
}

