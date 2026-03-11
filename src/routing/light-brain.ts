/**
 * Light Brain - Gemini Handler via Antigravity Proxy
 *
 * Handles lightweight tasks using Gemini 3 Flash through the Antigravity Proxy.
 * Part of the double-brain architecture.
 */

import type { LightBrainConfig } from "../config/types.routing.js";

export type LightBrainResponse = {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  model: string;
  provider: string;
};

export type LightBrainRequest = {
  message: string;
  systemPrompt?: string;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  maxTokens?: number;
};

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_MODEL = "gemini-3-flash";
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Call Gemini via Antigravity Proxy
 */
export async function callLightBrain(
  request: LightBrainRequest,
  config?: LightBrainConfig,
): Promise<LightBrainResponse> {
  const baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
  const model = config?.model ?? DEFAULT_MODEL;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Build messages array
  const messages: Array<{ role: string; content: string }> = [];

  // Add conversation history if provided
  if (request.conversationHistory) {
    for (const msg of request.conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  // Add current message
  messages.push({
    role: "user",
    content: request.message,
  });

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  // Add system prompt if provided
  if (request.systemPrompt) {
    body.system = request.systemPrompt;
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "antigravity", // Antigravity Proxy doesn't require real API key
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Light brain request failed: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
    model?: string;
  };

  // Extract text from response, skipping thinking blocks
  const textBlocks = data.content?.filter((block) => block.type === "text") ?? [];
  const text = textBlocks.map((block) => block.text ?? "").join("\n");

  return {
    text: text.trim() || "(No response)",
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    },
    model: data.model ?? model,
    provider: "antigravity",
  };
}

/**
 * Build system prompt for light brain
 */
export function buildLightBrainSystemPrompt(params: {
  soulContent?: string;
  memoryContent?: string;
  userName?: string;
}): string {
  const parts: string[] = [];

  parts.push(`You are a helpful AI assistant (Light Brain - Gemini).

IMPORTANT LIMITATIONS:
- You can have conversations, answer questions, and analyze content provided to you
- You CANNOT execute commands, run code, or modify files
- You CANNOT check system status, run docker commands, or access external systems
- You CANNOT read files from the user's system - only analyze content sent directly to you
- If the user asks you to DO something that requires system access (check, run, fix, execute, set up cron, etc.), tell them:
  "这个需要用 /code 前缀让 Claude 来处理，我只能回答问题和分析内容。"
- DO NOT pretend you can do things you cannot do
- DO NOT say "let me check" or "I will run" - you cannot do those things`);

  if (params.userName) {
    parts.push(`\nYou are chatting with ${params.userName}.`);
  }

  if (params.soulContent) {
    parts.push("\n## Identity\n" + params.soulContent);
  }

  if (params.memoryContent) {
    parts.push("\n## Memory\n" + params.memoryContent);
  }

  parts.push(
    "\nRespond concisely and helpfully. Use the same language as the user. Never pretend to have capabilities you don't have.",
  );

  return parts.join("\n");
}
