import type { AppConfig } from "../config.js";
import { BacklogClient } from "../backlog/client.js";
import { BacklogTracker } from "./adapters/backlog-tracker.js";
import { MockIssueTracker } from "./adapters/mock-tracker.js";
import type { IIssueTracker } from "./types.js";

/**
 * 設定に応じた IIssueTracker 実装を生成するファクトリ関数
 */
export function createTracker(config: AppConfig): IIssueTracker {
  switch (config.trackerType) {
    case "mock":
      return new MockIssueTracker();
    case "github":
      throw new Error("GitHub Issues トラッカーアダプターは現在実装準備中です。");
    case "backlog":
    default: {
      if (!config.backlogApiKey) {
        throw new Error(
          "【エラー】BACKLOG_API_KEY が設定されていません。.env ファイルに BACKLOG_API_KEY=xxx を設定してください。"
        );
      }
      const client = new BacklogClient(
        config.backlogSpaceId,
        config.backlogDomain,
        config.backlogApiKey
      );
      return new BacklogTracker({
        client,
        projectKey: config.backlogProjectKey,
      });
    }
  }
}

/**
 * レガシーな BacklogClient / モックオブジェクトを IIssueTracker にラップするヘルパー
 */
export function wrapLegacyIssueClient(
  clientOrTracker: IIssueTracker | object,
  customStatusModeOverride?: boolean,
  projectKey: string = ""
): IIssueTracker {
  if ("trackerType" in clientOrTracker) {
    return clientOrTracker as IIssueTracker;
  }
  return new BacklogTracker({
    client: clientOrTracker as BacklogClient,
    projectKey,
    customStatusModeOverride,
  });
}
