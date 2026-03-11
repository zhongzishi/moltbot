/**
 * Email send tool for agents.
 * Allows sending emails using stored IMAP/SMTP credentials.
 */

import { Type } from "@sinclair/typebox";

import { getChildLogger } from "../../logging.js";
import { sendEmail, listAvailableSenders } from "../../hooks/smtp.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, readStringParam } from "./common.js";

const logger = getChildLogger({ module: "email-send-tool" });

const EMAIL_SEND_ACTIONS = ["send", "reply", "list_senders"] as const;

const EmailSendToolSchema = Type.Object({
  action: stringEnum(EMAIL_SEND_ACTIONS),
  /** Sender email address (must have stored credentials via email_monitor) */
  from: Type.Optional(Type.String({ description: "Sender email address" })),
  /** Recipient email address(es), comma-separated for multiple */
  to: Type.Optional(Type.String({ description: "Recipient email address(es)" })),
  /** Email subject */
  subject: Type.Optional(Type.String({ description: "Email subject" })),
  /** Email body (plain text) */
  body: Type.Optional(Type.String({ description: "Email body content" })),
  /** CC recipients, comma-separated */
  cc: Type.Optional(Type.String({ description: "CC recipients" })),
  /** BCC recipients, comma-separated */
  bcc: Type.Optional(Type.String({ description: "BCC recipients" })),
  /** For reply action: the Message-ID of the email being replied to */
  inReplyTo: Type.Optional(
    Type.String({ description: "Message-ID of the email being replied to" }),
  ),
  /** For reply action: the References header for threading */
  references: Type.Optional(Type.String({ description: "References header for email threading" })),
});

/**
 * Create the email send tool for agent use.
 */
export function createEmailSendTool(): AnyAgentTool {
  return {
    label: "EmailSend",
    name: "email_send",
    description: `Send emails using stored credentials.

ACTIONS:
- list_senders: List available sender email accounts (those with stored credentials)
- send: Send a new email
- reply: Reply to an existing email (includes In-Reply-To header for threading)

REQUIREMENTS:
- Sender email must have credentials stored via email_monitor tool first
- SMTP settings are auto-detected for common providers (Gmail, QQ, Outlook, etc.)

EXAMPLES:

1. List available sender accounts:
{ "action": "list_senders" }

2. Send a new email:
{
  "action": "send",
  "from": "hr@company.com",
  "to": "employee@company.com",
  "subject": "请假申请已批准",
  "body": "您的请假申请已批准。请假时间：2月10日至2月12日，共3天。"
}

3. Reply to an email:
{
  "action": "reply",
  "from": "hr@company.com",
  "to": "employee@company.com",
  "subject": "Re: 请假申请",
  "body": "您的请假申请已批准。",
  "inReplyTo": "<original-message-id@mail.com>",
  "references": "<original-message-id@mail.com>"
}

4. Send with CC:
{
  "action": "send",
  "from": "hr@company.com",
  "to": "employee@company.com",
  "cc": "manager@company.com",
  "subject": "请假申请处理结果",
  "body": "..."
}`,
    parameters: EmailSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      logger.info({ action }, "email-send-tool: execute");

      switch (action) {
        case "list_senders": {
          const senders = await listAvailableSenders();
          if (senders.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No sender accounts available. Use email_monitor to add email credentials first.",
                },
              ],
              details: { action: "list_senders", count: 0 },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Available sender accounts:\n${senders.map((s) => `- ${s}`).join("\n")}`,
              },
            ],
            details: { action: "list_senders", senders },
          };
        }

        case "send":
        case "reply": {
          const from = readStringParam(params, "from", { required: true, label: "from" });
          const to = readStringParam(params, "to", { required: true, label: "to" });
          const subject = readStringParam(params, "subject", { required: true, label: "subject" });
          const body = readStringParam(params, "body") ?? "";
          const cc = readStringParam(params, "cc");
          const bcc = readStringParam(params, "bcc");
          const inReplyTo = readStringParam(params, "inReplyTo");
          const references = readStringParam(params, "references");

          // Parse multiple recipients
          const toList = to
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean);
          const ccList = cc
            ?.split(",")
            .map((e) => e.trim())
            .filter(Boolean);
          const bccList = bcc
            ?.split(",")
            .map((e) => e.trim())
            .filter(Boolean);

          const result = await sendEmail({
            from,
            to: toList,
            subject,
            text: body,
            cc: ccList,
            bcc: bccList,
            inReplyTo: action === "reply" ? inReplyTo : undefined,
            references: action === "reply" ? references : undefined,
          });

          if (result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully!\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nMessage-ID: ${result.messageId}`,
                },
              ],
              details: {
                action,
                success: true,
                from,
                to: toList,
                subject,
                messageId: result.messageId,
              },
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to send email: ${result.error}`,
                },
              ],
              details: {
                action,
                success: false,
                error: result.error,
              },
            };
          }
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${action}. Valid actions: list_senders, send, reply`,
              },
            ],
            details: { error: "unknown_action", action },
          };
      }
    },
  };
}
