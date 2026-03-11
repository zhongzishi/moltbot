/**
 * Trello webhook transform for hook mappings.
 * This module is loaded dynamically by the hooks system.
 */

import {
  extractCardId,
  formatActionMessage,
  isInterestingAction,
  type TrelloWebhookPayload,
} from "./trello-ops.js";

export type TrelloTransformContext = {
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  url: URL;
  path: string;
};

/**
 * Transform Trello webhook payload into agent action.
 * Returns null to skip uninteresting actions.
 */
export function transform(ctx: TrelloTransformContext) {
  const payload = ctx.payload as unknown as TrelloWebhookPayload;

  // Validate payload structure
  if (!payload?.action?.type || !payload?.model?.id) {
    return null; // Skip invalid payloads
  }

  // Skip uninteresting actions
  if (!isInterestingAction(payload.action)) {
    return null;
  }

  const message = formatActionMessage(payload);
  const cardId = extractCardId(payload);
  const actionType = payload.action.type;
  const boardId = payload.model.id;

  // Build session key based on card (if available) or board
  const sessionKey = cardId
    ? `hook:trello:card:${cardId}`
    : `hook:trello:board:${boardId}`;

  // Build system prompt based on action type
  let systemContext = "";
  if (actionType === "commentCard") {
    systemContext = `
你收到了一个 Trello 卡片上的新评论。请分析评论内容：
1. 如果是用户提出的问题或 bug 报告，尝试使用可用的工具查找相关信息
2. 如果问题简单且你有足够信息回答，使用 trello 工具的 add_comment action 直接在卡片上回复
3. 如果问题复杂或需要人工介入，只需通知我并附上你的发现

当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  } else if (actionType === "createCard") {
    systemContext = `
Trello 看板上创建了新卡片。请分析卡片内容：
1. 如果卡片描述了一个问题或任务，尝试理解其内容
2. 如果你能提供初步分析或相关信息，使用 trello 工具添加评论
3. 通知我关于这个新卡片

当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  } else if (actionType === "updateCard") {
    systemContext = `
Trello 卡片状态发生了变化。通知我这个变化。

当前卡片 ID: ${cardId || "未知"}
看板 ID: ${boardId}
`;
  }

  return {
    message: systemContext + "\n\n" + message,
    sessionKey,
    name: `Trello: ${actionType}`,
    deliver: true, // Always notify user
    wakeMode: "now" as const,
  };
}

export default transform;
