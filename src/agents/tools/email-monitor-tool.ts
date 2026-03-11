import { Type } from "@sinclair/typebox";

import { addImapMonitor, listImapMonitors, removeImapMonitor } from "../../hooks/imap-tool.js";
import { getChildLogger } from "../../logging.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const logger = getChildLogger({ module: "email-monitor-tool" });

const EMAIL_MONITOR_ACTIONS = ["add", "remove", "list"] as const;

const EmailMonitorToolSchema = Type.Object({
  action: stringEnum(EMAIL_MONITOR_ACTIONS),
  email: Type.Optional(Type.String({ description: "Email address to monitor or remove" })),
  password: Type.Optional(
    Type.String({ description: "App password or authorization code for IMAP access" }),
  ),
  host: Type.Optional(
    Type.String({ description: "IMAP server host (auto-detected if not provided)" }),
  ),
  port: Type.Optional(Type.Number({ description: "IMAP server port (default: 993)" })),
});

/**
 * Extract owner ID from session key.
 * Session key format: agent:<agentId>:<channel>:<type>:<userId>
 * For example: agent:main:feishu:dm:ou_xxx -> ou_xxx
 */
function extractOwnerIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":").filter(Boolean);
  // Handle agent:main:channel:type:userId format
  if (parts[0] === "agent" && parts.length >= 5) {
    // agent:main:feishu:dm:ou_xxx -> ou_xxx
    return parts.slice(4).join(":");
  }
  // Handle channel:type:userId format
  if (parts.length >= 3) {
    return parts.slice(2).join(":");
  }
  return undefined;
}

export type EmailMonitorToolOptions = {
  sessionKey?: string;
};

/**
 * Create the email monitor tool for agent use.
 * Allows users to add/remove/list email monitors via chat.
 */
export function createEmailMonitorTool(options?: EmailMonitorToolOptions): AnyAgentTool {
  // Extract ownerId from sessionKey (requires dmScope="per-channel-peer" config)
  const ownerId = extractOwnerIdFromSessionKey(options?.sessionKey);
  logger.debug({ sessionKey: options?.sessionKey, ownerId }, "email-monitor-tool: created");

  return {
    label: "EmailMonitor",
    name: "email_monitor",
    description:
      "Manage email monitoring. Actions: add (start monitoring an email inbox), remove (stop monitoring), list (show all monitors). For 'add', requires email and password (app password). Host/port are auto-detected for Gmail, Outlook, Yahoo, etc.",
    parameters: EmailMonitorToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      logger.info({ action, ownerId, hasEmail: !!params.email }, "email-monitor-tool: execute");

      switch (action) {
        case "add": {
          if (!ownerId) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Cannot determine owner ID from session. Please contact via a messaging channel (e.g., Feishu DM).",
                },
              ],
              details: { action: "add", error: "no_owner_id" },
            };
          }

          const email = readStringParam(params, "email", { required: true, label: "email" });
          const password = readStringParam(params, "password", {
            required: true,
            label: "password",
            trim: false,
          });
          const host = readStringParam(params, "host");
          const port = typeof params.port === "number" ? params.port : undefined;

          const result = await addImapMonitor({ email, password, host, port, ownerId });
          return {
            content: [{ type: "text", text: result }],
            details: { action: "add", email },
          };
        }

        case "remove": {
          const email = readStringParam(params, "email", { required: true, label: "email" });
          const result = await removeImapMonitor({ email });
          return {
            content: [{ type: "text", text: result }],
            details: { action: "remove", email },
          };
        }

        case "list": {
          const result = await listImapMonitors();
          return {
            content: [{ type: "text", text: result }],
            details: { action: "list" },
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
