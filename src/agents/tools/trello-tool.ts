/**
 * Trello tool for agent to interact with Trello boards, cards, and comments.
 */

import { Type } from "@sinclair/typebox";

import {
  addCardComment,
  getBoard,
  getBoardActions,
  getBoardCards,
  getBoardLists,
  getCard,
  getCardComments,
  moveCard,
  updateCard,
  type TrelloCredentials,
} from "../../hooks/trello-ops.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const TRELLO_ACTIONS = [
  "get_card",
  "get_comments",
  "add_comment",
  "get_board",
  "get_lists",
  "get_cards",
  "get_actions",
  "move_card",
  "update_card",
] as const;

const TrelloToolSchema = Type.Object({
  action: stringEnum(TRELLO_ACTIONS),
  // Card operations
  cardId: Type.Optional(Type.String({ description: "Card ID or short link" })),
  // Board operations
  boardId: Type.Optional(Type.String({ description: "Board ID or short link" })),
  // Comment
  text: Type.Optional(Type.String({ description: "Comment text to add" })),
  // Move card
  listId: Type.Optional(Type.String({ description: "Target list ID for move_card" })),
  // Update card
  name: Type.Optional(Type.String({ description: "New card name" })),
  desc: Type.Optional(Type.String({ description: "New card description" })),
  due: Type.Optional(Type.String({ description: "Due date (ISO string or null)" })),
  closed: Type.Optional(Type.Boolean({ description: "Archive (true) or unarchive (false)" })),
  // Pagination
  limit: Type.Optional(Type.Number({ description: "Number of items to return" })),
  filter: Type.Optional(Type.String({ description: "Filter: all, open, closed" })),
});

export type TrelloToolOptions = {
  credentials?: TrelloCredentials;
};

export function createTrelloTool(options?: TrelloToolOptions): AnyAgentTool {
  return {
    label: "Trello",
    name: "trello",
    description: `Interact with Trello boards, cards, and comments.

ACTIONS:
- get_card: Get card details (cardId required)
- get_comments: Get card comments (cardId required, limit optional)
- add_comment: Add comment to card (cardId, text required)
- get_board: Get board details (boardId required)
- get_lists: Get lists on board (boardId required)
- get_cards: Get cards on board (boardId required, filter: all/open/closed)
- get_actions: Get recent board activity (boardId required, limit optional)
- move_card: Move card to list (cardId, listId required)
- update_card: Update card (cardId required, name/desc/due/closed optional)

EXAMPLES:
1. Get card: { "action": "get_card", "cardId": "abc123" }
2. Add comment: { "action": "add_comment", "cardId": "abc123", "text": "分析完成，这是一个简单的配置问题..." }
3. Get board lists: { "action": "get_lists", "boardId": "xyz789" }
4. Move card: { "action": "move_card", "cardId": "abc123", "listId": "list456" }
5. Get recent activity: { "action": "get_actions", "boardId": "xyz789", "limit": 20 }`,
    parameters: TrelloToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      // Get credentials from options or environment
      const creds: TrelloCredentials = options?.credentials ?? {
        apiKey: process.env.TRELLO_API_KEY ?? "",
        token: process.env.TRELLO_TOKEN ?? "",
      };

      if (!creds.apiKey || !creds.token) {
        return jsonResult({
          ok: false,
          error: "Trello credentials not configured. Set TRELLO_API_KEY and TRELLO_TOKEN.",
        });
      }

      const cardId = readStringParam(params, "cardId");
      const boardId = readStringParam(params, "boardId");
      const text = readStringParam(params, "text");
      const listId = readStringParam(params, "listId");
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : undefined;

      try {
        switch (action) {
          case "get_card": {
            if (!cardId) return jsonResult({ ok: false, error: "cardId required" });
            const card = await getCard(creds, cardId);
            return jsonResult({ ok: true, card });
          }

          case "get_comments": {
            if (!cardId) return jsonResult({ ok: false, error: "cardId required" });
            const comments = await getCardComments(creds, cardId, limit ?? 10);
            return jsonResult({ ok: true, comments });
          }

          case "add_comment": {
            if (!cardId) return jsonResult({ ok: false, error: "cardId required" });
            if (!text) return jsonResult({ ok: false, error: "text required" });
            const comment = await addCardComment(creds, cardId, text);
            return jsonResult({ ok: true, comment });
          }

          case "get_board": {
            if (!boardId) return jsonResult({ ok: false, error: "boardId required" });
            const board = await getBoard(creds, boardId);
            return jsonResult({ ok: true, board });
          }

          case "get_lists": {
            if (!boardId) return jsonResult({ ok: false, error: "boardId required" });
            const lists = await getBoardLists(creds, boardId);
            return jsonResult({ ok: true, lists });
          }

          case "get_cards": {
            if (!boardId) return jsonResult({ ok: false, error: "boardId required" });
            const filter = (readStringParam(params, "filter") as "all" | "open" | "closed") ?? "open";
            const cards = await getBoardCards(creds, boardId, filter);
            return jsonResult({ ok: true, cards });
          }

          case "get_actions": {
            if (!boardId) return jsonResult({ ok: false, error: "boardId required" });
            const actions = await getBoardActions(creds, boardId, limit ?? 50);
            return jsonResult({ ok: true, actions });
          }

          case "move_card": {
            if (!cardId) return jsonResult({ ok: false, error: "cardId required" });
            if (!listId) return jsonResult({ ok: false, error: "listId required" });
            const card = await moveCard(creds, cardId, listId);
            return jsonResult({ ok: true, card });
          }

          case "update_card": {
            if (!cardId) return jsonResult({ ok: false, error: "cardId required" });
            const updates: Record<string, unknown> = {};
            const name = readStringParam(params, "name");
            const desc = readStringParam(params, "desc");
            const due = readStringParam(params, "due");
            if (name) updates.name = name;
            if (desc) updates.desc = desc;
            if (due !== undefined) updates.due = due === "null" ? null : due;
            if (typeof params.closed === "boolean") updates.closed = params.closed;
            if (Object.keys(updates).length === 0) {
              return jsonResult({ ok: false, error: "No updates provided" });
            }
            const card = await updateCard(creds, cardId, updates as Parameters<typeof updateCard>[2]);
            return jsonResult({ ok: true, card });
          }

          default:
            return jsonResult({ ok: false, error: `Unknown action: ${action}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, error: message });
      }
    },
  };
}
