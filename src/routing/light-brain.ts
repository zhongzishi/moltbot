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
 * Marker that Gemini uses to indicate it needs to delegate to Claude
 */
export const DELEGATE_MARKER = "[DELEGATE_TO_CLAUDE]";

/**
 * Check if Gemini's response indicates it needs to delegate to Claude
 */
export function needsDelegation(response: string): {
  needs: boolean;
  reason?: string;
  cleanedResponse?: string;
} {
  if (response.includes(DELEGATE_MARKER)) {
    // Extract reason if provided: [DELEGATE_TO_CLAUDE: reason here]
    const match = response.match(/\[DELEGATE_TO_CLAUDE(?::\s*([^\]]+))?\]/);
    const reason = match?.[1]?.trim();

    // Remove the marker from response (in case we want to show partial response)
    const cleanedResponse = response.replace(/\[DELEGATE_TO_CLAUDE(?::\s*[^\]]+)?\]/g, "").trim();

    return { needs: true, reason, cleanedResponse };
  }
  return { needs: false };
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

## YOUR CAPABILITIES:
✓ Answer questions, explain concepts, discuss topics
✓ Analyze content, summarize text, translate
✓ Have conversations, provide advice, brainstorm ideas
✓ Write text, draft messages, compose content

## YOU CANNOT:
✗ Execute commands, run code, or access the file system
✗ Check logs, docker status, or system state
✗ Create/edit/delete files
✗ Run tests, build projects, or deploy
✗ Access databases, APIs, or external services
✗ Set up cron jobs, reminders with system integration
✗ Search the web or fetch real-time information (weather, news, stock prices, etc.)

## DELEGATION PROTOCOL:
When the user asks you to DO something that requires system access, tools, or code execution, you MUST respond with ONLY:

${DELEGATE_MARKER}

Do NOT explain why. Do NOT apologize. Just output the marker and nothing else.

Examples of when to delegate:
- "帮我看看 xxx" (需要查看文件/日志)
- "运行一下测试" (需要执行命令)
- "检查 docker 状态" (需要系统访问)
- "帮我改一下这个文件" (需要编辑文件)
- "部署到生产环境" (需要执行部署)
- "设置一个定时任务" (需要 cron)
- "git push" (需要执行 git 命令)
- "今天天气怎么样？" (需要搜索实时天气)
- "最新的新闻" (需要搜索实时信息)
- "xxx 股票价格" (需要实时数据)
- Any request involving: check, run, execute, fix, deploy, build, edit, create, delete, grep, find
- Any request for REAL-TIME information: weather, news, stock prices, current events, live data

Examples of what you CAN handle directly:
- "xxx 是什么意思？" (解释概念)
- "帮我翻译这段话" (翻译)
- "这段代码有什么问题？" (分析，不需要运行)
- "写一封邮件给..." (写作)
- "推荐一些学习资源" (建议)
- "曼谷 2 月通常天气如何？" (历史/一般性知识，不需要实时数据)`);

  if (params.userName) {
    parts.push(`\n你正在和 ${params.userName} 聊天。`);
  }

  if (params.soulContent) {
    parts.push("\n## Identity\n" + params.soulContent);
  }

  if (params.memoryContent) {
    parts.push("\n## Memory\n" + params.memoryContent);
  }

  parts.push("\n用户使用什么语言，你就用什么语言回复。回答要简洁有帮助。");

  return parts.join("\n");
}
