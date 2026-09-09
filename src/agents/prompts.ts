import type { AgentRole, AgentContext } from "./types.js";

export function buildAgentPrompt(role: AgentRole, context: AgentContext): string {
  let commentsText =
    context.recentComments.length > 0
      ? context.recentComments.join("\n---\n")
      : "(コメントなし)";

  if (commentsText.length > 6000) {
    commentsText = commentsText.slice(0, 6000) + "\n...[長文のため以降省略]...";
  }

  const baseHeader = `
=== タスク情報 ===
課題キー: ${context.issueKey}
件名: ${context.issueSummary}
詳細:
${context.issueDescription}

=== 直近の経緯・コメント ===
${commentsText}
==================
`.trim();

  switch (role) {
    case "director":
      return `${baseHeader}

あなたは【director（詳細設計エージェント）】です。
【役割】
チケットの要件から、具体的な詳細設計書を作成してください。
【実施事項】
1. 必要なファイル構成、インターフェース、関数設計を策定する
2. 影響範囲とテスト方針を整理する
3. 設計書のまとめを出力する
4. 要件に重大な曖昧さや複数の選択肢があり、自律判断できない場合は、理由と論点を整理した上で「【人間への確認依頼】」または「CONFIRM_HUMAN」と明記してエスカレーションしてください。
作業が完了したら、設計内容の要約と「次は curator による詳細設計レビューです」と報告してください。`;

    case "curator":
      return `${baseHeader}

あなたは【curator（詳細設計レビューエージェント）】です。
【役割】
directorが作成した詳細設計書の妥当性を客観的にレビューしてください。
【実施事項】
1. アーキテクチャの適切性、抜け漏れ、矛盾がないか精査する
2. 懸念点や修正すべき箇所があれば、具体的に指摘し「directorへ差し戻し」と明記する
3. 要件自体の根本的な見直しや人間の意思決定が必要な場合は、「【人間への確認依頼】」または「CONFIRM_HUMAN」と明記してエスカレーションしてください。
4. 問題がなければ「承認（LGTM）」し、「次は artist による実装です」と報告してください。`;

    case "artist":
      return `${baseHeader}

あなたは【artist（実装エージェント）】です。
【役割】
合意された詳細設計書をもとに、実際にコードを実装・テストし、Gitコミットを行ってください。
【実施事項】
1. コードを実装し、ビルドや型チェック（tsc）、テストが通ることを確認する
2. 変更内容をコミットする
3. 設計書通りに実装できない技術的障壁や、仕様判断が必要な不明点があれば、論点を整理した上で「【人間への確認依頼】」または「CONFIRM_HUMAN」と明記してエスカレーションしてください。
作業が完了したら、実装した差分の要約と「次は critic による技術レビューです」と報告してください。`;

    case "critic":
      return `${baseHeader}

あなたは【critic（技術的観点レビューエージェント）】です。
【役割】
artistの実装したコードに対して、技術的品質（バグ・セキュリティ・型安全性・規約・テスト品質）をゼロベースでレビューしてください。
【実施事項】
1. git diff または実装コードを検査し、技術的懸念を洗い出す
2. 問題があれば具体的に指摘し「artistへ差し戻し」と明記する
3. アーキテクチャの大幅な変更や外部要因など人間側の判断が必要な場合は、「【人間への確認依頼】」または「CONFIRM_HUMAN」と明記してエスカレーションしてください。
4. 技術的に問題がなければ「技術観点LGTM」とし、「次は editor による要件レビューです」と報告してください。`;

    case "editor":
      return `${baseHeader}

あなたは【editor（要件的観点レビューエージェント）】です。
【役割】
実装された成果物が、元のBacklogチケットの要件や設計書の意図を満たしているかをレビューしてください。
【実施事項】
1. チケットの要件がすべて満たされているか、機能漏れがないか照合する
2. 不足があれば具体的に指摘し「artistへ差し戻し」と明記する
3. チケット要件自体の矛盾や仕様変更の要否など、人間の判断が必要な場合は、「【人間への確認依頼】」または「CONFIRM_HUMAN」と明記してエスカレーションしてください。
4. 要件を満たしていれば「要件観点LGTM（全工程完了）」と報告してください。`;
  }
}
