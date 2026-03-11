/**
 * Trello API operations for webhook handling and agent tools.
 */

import { getChildLogger } from "../logging.js";

const logger = getChildLogger({ module: "trello-ops" });

export type TrelloCredentials = {
  apiKey: string;
  token: string;
};

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  url: string;
  shortUrl: string;
  idList: string;
  idBoard: string;
  labels: Array<{ id: string; name: string; color: string }>;
  due: string | null;
  closed: boolean;
};

export type TrelloList = {
  id: string;
  name: string;
  idBoard: string;
  closed: boolean;
};

export type TrelloBoard = {
  id: string;
  name: string;
  url: string;
  shortUrl: string;
};

export type TrelloMember = {
  id: string;
  username: string;
  fullName: string;
};

export type TrelloComment = {
  id: string;
  data: {
    text: string;
    card?: { id: string; name: string };
  };
  memberCreator: TrelloMember;
  date: string;
};

export type TrelloWebhookAction = {
  id: string;
  type: string;
  date: string;
  memberCreator?: TrelloMember;
  data: {
    text?: string;
    card?: { id: string; name: string; shortLink?: string; desc?: string };
    list?: { id: string; name: string };
    listBefore?: { id: string; name: string };
    listAfter?: { id: string; name: string };
    board?: { id: string; name: string; shortLink?: string };
    old?: Record<string, unknown>;
  };
};

export type TrelloWebhookPayload = {
  action: TrelloWebhookAction;
  model: {
    id: string;
    name: string;
  };
};

const TRELLO_API_BASE = "https://api.trello.com/1";

async function trelloFetch<T>(
  creds: TrelloCredentials,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(`${TRELLO_API_BASE}${endpoint}`);
  url.searchParams.set("key", creds.apiKey);
  url.searchParams.set("token", creds.token);

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Trello API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get a card by ID.
 */
export async function getCard(creds: TrelloCredentials, cardId: string): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(creds, `/cards/${cardId}`);
}

/**
 * Get comments on a card.
 */
export async function getCardComments(
  creds: TrelloCredentials,
  cardId: string,
  limit = 10,
): Promise<TrelloComment[]> {
  return trelloFetch<TrelloComment[]>(
    creds,
    `/cards/${cardId}/actions?filter=commentCard&limit=${limit}`,
  );
}

/**
 * Add a comment to a card.
 */
export async function addCardComment(
  creds: TrelloCredentials,
  cardId: string,
  text: string,
): Promise<TrelloComment> {
  return trelloFetch<TrelloComment>(creds, `/cards/${cardId}/actions/comments`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * Get a board by ID.
 */
export async function getBoard(creds: TrelloCredentials, boardId: string): Promise<TrelloBoard> {
  return trelloFetch<TrelloBoard>(creds, `/boards/${boardId}`);
}

/**
 * Get lists on a board.
 */
export async function getBoardLists(
  creds: TrelloCredentials,
  boardId: string,
): Promise<TrelloList[]> {
  return trelloFetch<TrelloList[]>(creds, `/boards/${boardId}/lists`);
}

/**
 * Get cards on a board.
 */
export async function getBoardCards(
  creds: TrelloCredentials,
  boardId: string,
  filter: "all" | "open" | "closed" = "open",
): Promise<TrelloCard[]> {
  return trelloFetch<TrelloCard[]>(creds, `/boards/${boardId}/cards?filter=${filter}`);
}

/**
 * Get recent actions on a board.
 */
export async function getBoardActions(
  creds: TrelloCredentials,
  boardId: string,
  limit = 50,
): Promise<TrelloWebhookAction[]> {
  return trelloFetch<TrelloWebhookAction[]>(creds, `/boards/${boardId}/actions?limit=${limit}`);
}

/**
 * Move a card to a different list.
 */
export async function moveCard(
  creds: TrelloCredentials,
  cardId: string,
  listId: string,
): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(creds, `/cards/${cardId}`, {
    method: "PUT",
    body: JSON.stringify({ idList: listId }),
  });
}

/**
 * Update a card's properties.
 */
export async function updateCard(
  creds: TrelloCredentials,
  cardId: string,
  updates: Partial<{ name: string; desc: string; due: string | null; closed: boolean }>,
): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(creds, `/cards/${cardId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

/**
 * Create a webhook for a board.
 */
export async function createWebhook(
  creds: TrelloCredentials,
  modelId: string,
  callbackUrl: string,
  description?: string,
): Promise<{ id: string; callbackURL: string; idModel: string }> {
  return trelloFetch(creds, "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      idModel: modelId,
      callbackURL: callbackUrl,
      description: description ?? `Moltbot webhook for ${modelId}`,
    }),
  });
}

/**
 * Delete a webhook.
 */
export async function deleteWebhook(creds: TrelloCredentials, webhookId: string): Promise<void> {
  await trelloFetch(creds, `/webhooks/${webhookId}`, { method: "DELETE" });
}

/**
 * List all webhooks for the token.
 */
export async function listWebhooks(
  creds: TrelloCredentials,
): Promise<Array<{ id: string; callbackURL: string; idModel: string; description: string }>> {
  return trelloFetch(creds, `/tokens/${creds.token}/webhooks`);
}

// ============ Webhook Payload Parsing ============

const INTERESTING_ACTION_TYPES = new Set([
  "createCard",
  "commentCard",
  "updateCard",
  "addMemberToCard",
  "removeMemberFromCard",
  "addLabelToCard",
  "removeLabelFromCard",
  "addAttachmentToCard",
  "deleteCard",
]);

/**
 * Check if a webhook action is interesting (should trigger agent).
 */
export function isInterestingAction(action: TrelloWebhookAction): boolean {
  return INTERESTING_ACTION_TYPES.has(action.type);
}

/**
 * Format a webhook action into a human-readable message for the agent.
 */
export function formatActionMessage(payload: TrelloWebhookPayload): string {
  const { action, model } = payload;
  const actor = action.memberCreator?.fullName ?? action.memberCreator?.username ?? "Someone";
  const card = action.data.card;
  const board = model.name;

  switch (action.type) {
    case "createCard": {
      const list = action.data.list?.name ?? "a list";
      return `[Trello] ${actor} 在看板「${board}」的「${list}」列表中创建了新卡片「${card?.name}」\n卡片描述: ${card?.desc || "(无描述)"}\n卡片链接: https://trello.com/c/${card?.shortLink}`;
    }
    case "commentCard": {
      const text = action.data.text ?? "";
      return `[Trello] ${actor} 在看板「${board}」的卡片「${card?.name}」上发表了评论:\n${text}\n卡片链接: https://trello.com/c/${card?.shortLink}`;
    }
    case "updateCard": {
      const old = action.data.old;
      if (action.data.listAfter && action.data.listBefore) {
        return `[Trello] ${actor} 将卡片「${card?.name}」从「${action.data.listBefore.name}」移动到「${action.data.listAfter.name}」(看板: ${board})\n卡片链接: https://trello.com/c/${card?.shortLink}`;
      }
      if (old && "closed" in old) {
        const status = (old.closed as boolean) ? "重新打开" : "归档";
        return `[Trello] ${actor} ${status}了卡片「${card?.name}」(看板: ${board})\n卡片链接: https://trello.com/c/${card?.shortLink}`;
      }
      return `[Trello] ${actor} 更新了卡片「${card?.name}」(看板: ${board})\n卡片链接: https://trello.com/c/${card?.shortLink}`;
    }
    case "addMemberToCard":
      return `[Trello] ${actor} 将成员添加到卡片「${card?.name}」(看板: ${board})`;
    case "removeMemberFromCard":
      return `[Trello] ${actor} 从卡片「${card?.name}」移除了成员 (看板: ${board})`;
    case "addLabelToCard":
      return `[Trello] ${actor} 为卡片「${card?.name}」添加了标签 (看板: ${board})`;
    case "removeLabelFromCard":
      return `[Trello] ${actor} 从卡片「${card?.name}」移除了标签 (看板: ${board})`;
    case "addAttachmentToCard":
      return `[Trello] ${actor} 为卡片「${card?.name}」添加了附件 (看板: ${board})`;
    case "deleteCard":
      return `[Trello] ${actor} 删除了卡片「${card?.name}」(看板: ${board})`;
    default:
      return `[Trello] ${actor} 在看板「${board}」上执行了操作: ${action.type}`;
  }
}

/**
 * Extract card ID from webhook payload.
 */
export function extractCardId(payload: TrelloWebhookPayload): string | undefined {
  return payload.action.data.card?.id;
}

/**
 * Extract board ID from webhook payload.
 */
export function extractBoardId(payload: TrelloWebhookPayload): string {
  return payload.model.id;
}

/**
 * Extract the member ID of who performed the action.
 */
export function extractActorId(payload: TrelloWebhookPayload): string | undefined {
  return payload.action.memberCreator?.id;
}

/**
 * Check if the action was performed by a specific member (to skip self-actions).
 */
export function isActionBySelf(payload: TrelloWebhookPayload, ownerId: string): boolean {
  const actorId = extractActorId(payload);
  return actorId === ownerId;
}
