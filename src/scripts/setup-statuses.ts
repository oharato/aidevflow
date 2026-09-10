import { loadConfig } from "../config.js";
import { BacklogClient } from "../backlog/client.js";
import { JsonlLogger } from "../logger/jsonl.js";

interface TargetStatus {
  name: string;
  color: string;
  description: string;
}

const REQUIRED_STATUSES: TargetStatus[] = [
  { name: "詳細設計中", color: "#3b9dbd", description: "Director (詳細設計作成)" },
  { name: "設計レビュー中", color: "#868cb7", description: "Curator (詳細設計レビュー)" },
  { name: "実装中", color: "#eda62a", description: "Artist (コード実装 & コミット)" },
  { name: "技術レビュー中", color: "#b0be3c", description: "Critic (技術レビュー: 型/規約/バグ/依存バージョン)" },
  { name: "要件レビュー中", color: "#e07b9a", description: "Editor (要件充足度レビュー)" },
  { name: "確認待ち", color: "#f42858", description: "人間への確認依頼 / 差し戻し上限到達による一時停止" },
];

async function main() {
  console.log("==================================================");
  console.log("   aidevflow: Backlog カスタム状態セットアップ   ");
  console.log("==================================================");

  const config = loadConfig();
  const logger = new JsonlLogger(config.logFilePath);

  if (!config.backlogApiKey) {
    console.error("【エラー】BACKLOG_API_KEY が設定されていません。");
    console.error(".env ファイルに設定してください。");
    process.exit(1);
  }

  const backlog = new BacklogClient(
    config.backlogSpaceId,
    config.backlogDomain,
    config.backlogApiKey
  );

  console.log(`プロジェクト "${config.backlogProjectKey}" のステータス一覧を確認中...`);
  const project = await backlog.getProject(config.backlogProjectKey);
  console.log(`対象プロジェクト: ${project.name} (ID: ${project.id})`);

  const existingStatuses = await backlog.getProjectStatuses(project.id);
  console.log(`現在の登録ステータス件数: ${existingStatuses.length}件`);
  existingStatuses.forEach((st) => {
    console.log(`  - [ID: ${st.id}] "${st.name}" (色: ${st.color})`);
  });

  console.log("\n追加対象のステータスを確認中...");

  for (const target of REQUIRED_STATUSES) {
    const exists = existingStatuses.some(
      (st) => st.name.toLowerCase() === target.name.toLowerCase()
    );

    if (exists) {
      console.log(`  [スキップ] "${target.name}" は既に存在します。`);
      continue;
    }

    try {
      console.log(`  [追加中] "${target.name}" (${target.color}) を追加します...`);
      const created = await backlog.addStatus(project.id, target.name, target.color);
      console.log(`  ✓ 追加成功: [ID: ${created.id}] "${created.name}"`);

      logger.info("status_created", `ステータス "${target.name}" を作成しました`, {
        data: { statusId: created.id, name: created.name, color: created.color },
      });
    } catch (err: any) {
      console.error(`  ✗ 追加失敗: "${target.name}":`, err.message);
      logger.error("error", `ステータス "${target.name}" の追加に失敗しました: ${err.message}`);
    }
  }

  console.log("\nステータスセットアップ完了！");
}

main().catch((err) => {
  console.error("セットアップ失敗:", err);
  process.exit(1);
});
