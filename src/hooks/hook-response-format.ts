/**
 * Standardized response format for hook notifications.
 * Provides a consistent way to identify the source of notifications.
 */

export type HookSource = {
  emoji: string;
  name: string;
};

export const HOOK_SOURCES = {
  trello: { emoji: "📋", name: "Trello" },
  gmail: { emoji: "📧", name: "Gmail" },
  github: { emoji: "🐙", name: "GitHub" },
  slack: { emoji: "💬", name: "Slack" },
  webhook: { emoji: "🔔", name: "Webhook" },
  imap: { emoji: "📬", name: "Email" },
  calendar: { emoji: "📅", name: "Calendar" },
} as const;

export type HookSourceKey = keyof typeof HOOK_SOURCES;

/**
 * Build the response format instruction for a specific hook source.
 * This tells the agent to prefix responses with the source identifier.
 */
export function buildResponseFormatPrompt(source: HookSource | HookSourceKey): string {
  const src = typeof source === "string" ? HOOK_SOURCES[source] : source;
  const { emoji, name } = src;

  return `
## 回复格式要求
你的每条回复必须以来源标识开头，格式为：
**${emoji} ${name}** | <简短描述>

例如：
**${emoji} ${name}** | 任务完成
**${emoji} ${name}** | 需要注意

这样方便用户筛选不同来源的通知。
`;
}

/**
 * Build the full system context for a hook with response format included.
 */
export function buildHookSystemContext(params: {
  source: HookSource | HookSourceKey;
  context: string;
  tools?: string;
  extraInfo?: string;
}): string {
  const formatPrompt = buildResponseFormatPrompt(params.source);
  const parts = [params.context, formatPrompt];
  if (params.tools) parts.push(params.tools);
  if (params.extraInfo) parts.push(params.extraInfo);
  return parts.join("\n");
}
