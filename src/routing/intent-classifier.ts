/**
 * Intent Classifier for Double-Brain Routing
 *
 * Classifies incoming messages as "light" (handled by Gemini) or "heavy" (handled by Claude Code).
 * Uses quick heuristics first, then falls back to LLM classification for ambiguous cases.
 */

export type IntentClassification = "light" | "heavy";

export type ClassificationResult = {
  intent: IntentClassification;
  confidence: number;
  reason: string;
  /** Classification method: heuristic (keyword matching), llm (LLM classifier), or gemini-self-delegate */
  method: "heuristic" | "llm" | "gemini-self-delegate";
};

export type IntentClassifierConfig = {
  enabled?: boolean;
  /** Antigravity Proxy endpoint */
  baseUrl?: string;
  /** Model to use for classification (default: gemini-3-flash) */
  model?: string;
  /** Custom heavy keywords */
  heavyKeywords?: string[];
  /** Custom light keywords */
  lightKeywords?: string[];
  /** Code block line threshold (default: 50) */
  codeBlockThreshold?: number;
};

const DEFAULT_HEAVY_KEYWORDS = [
  "refactor",
  "重构",
  "implement",
  "实现",
  "debug",
  "调试",
  "fix bug",
  "修复",
  "write code",
  "写代码",
  "create file",
  "创建文件",
  "edit file",
  "编辑文件",
  "add feature",
  "添加功能",
  "build",
  "构建",
  "compile",
  "编译",
  "deploy",
  "部署",
  "test",
  "测试",
  "unit test",
  "单元测试",
  "integration",
  "集成",
  "架构",
  "architecture",
  "设计模式",
  "design pattern",
  // Action keywords that require tool execution
  "你看看",
  "看一下",
  "检查一下",
  "帮我看",
  "帮我查",
  "run",
  "执行",
  "启动",
  "重启",
  "restart",
  "stop",
  "停止",
  "docker",
  "容器",
  "日志",
  "logs",
];

const DEFAULT_LIGHT_KEYWORDS = [
  // Questions and explanations
  "what is",
  "什么是",
  "how to",
  "怎么样",
  "explain",
  "解释",
  "describe",
  "描述",
  "tell me",
  "告诉我",
  "为什么",
  "why",
  // Greetings
  "hi",
  "hello",
  "你好",
  "哈啰",
  "嗨",
  "早上好",
  "晚上好",
  "thanks",
  "谢谢",
  "thank you",
  // Simple queries (knowledge, not action)
  "query",
  "查询",
  "search",
  "搜索",
  "meaning of",
  "意思是",
];

/**
 * Count lines in code blocks within a message
 */
function countCodeBlockLines(message: string): number {
  const codeBlockRegex = /```[\s\S]*?```/g;
  const matches = message.match(codeBlockRegex) || [];
  let totalLines = 0;
  for (const block of matches) {
    const lines = block.split("\n").length - 2; // Subtract opening and closing ```
    totalLines += Math.max(0, lines);
  }
  return totalLines;
}

/**
 * Check if message contains any keyword from the list
 */
function containsKeyword(message: string, keywords: string[]): boolean {
  const lowerMessage = message.toLowerCase();
  return keywords.some((keyword) => lowerMessage.includes(keyword.toLowerCase()));
}

/**
 * Quick heuristic classification without LLM call
 */
export function quickClassify(
  message: string,
  config?: IntentClassifierConfig,
): ClassificationResult | null {
  const heavyKeywords = config?.heavyKeywords ?? DEFAULT_HEAVY_KEYWORDS;
  const lightKeywords = config?.lightKeywords ?? DEFAULT_LIGHT_KEYWORDS;
  const codeBlockThreshold = config?.codeBlockThreshold ?? 50;

  // Check for large code blocks
  const codeLines = countCodeBlockLines(message);
  if (codeLines > codeBlockThreshold) {
    return {
      intent: "heavy",
      confidence: 0.95,
      reason: `Code block with ${codeLines} lines (threshold: ${codeBlockThreshold})`,
      method: "heuristic",
    };
  }

  // Check for heavy keywords
  if (containsKeyword(message, heavyKeywords)) {
    // But if it also contains light keywords, it's ambiguous
    if (containsKeyword(message, lightKeywords)) {
      return null; // Ambiguous, need LLM
    }
    return {
      intent: "heavy",
      confidence: 0.8,
      reason: "Contains heavy task keywords",
      method: "heuristic",
    };
  }

  // Check for light keywords only
  if (containsKeyword(message, lightKeywords)) {
    return {
      intent: "light",
      confidence: 0.85,
      reason: "Contains light task keywords",
      method: "heuristic",
    };
  }

  // Short messages without code are usually light
  if (message.length < 100 && codeLines === 0) {
    return {
      intent: "light",
      confidence: 0.7,
      reason: "Short message without code",
      method: "heuristic",
    };
  }

  // Ambiguous, need LLM
  return null;
}

/**
 * LLM-based classification using Gemini via Antigravity Proxy
 */
export async function llmClassify(
  message: string,
  config?: IntentClassifierConfig,
): Promise<ClassificationResult> {
  const baseUrl = config?.baseUrl ?? "http://localhost:8080";
  const model = config?.model ?? "gemini-3-flash";

  const systemPrompt = `You are an intent classifier for an AI assistant system.
Your job is to classify user messages into two categories:
- "light": Simple questions, lookups, explanations, status checks, greetings
- "heavy": Coding tasks, refactoring, debugging, file operations, implementation

Respond with ONLY a JSON object in this exact format:
{"intent": "light" or "heavy", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test", // Antigravity Proxy doesn't need real key
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: `Classify this message:\n\n${message.slice(0, 500)}`, // Truncate for efficiency
          },
        ],
        system: systemPrompt,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM classification failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text ?? "";

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        intent?: string;
        confidence?: number;
        reason?: string;
      };
      return {
        intent: parsed.intent === "heavy" ? "heavy" : "light",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        reason: parsed.reason ?? "LLM classification",
        method: "llm",
      };
    }

    // Fallback: check for keywords in response
    const lowerText = text.toLowerCase();
    if (lowerText.includes("heavy")) {
      return { intent: "heavy", confidence: 0.6, reason: "LLM indicated heavy", method: "llm" };
    }
    return { intent: "light", confidence: 0.6, reason: "LLM indicated light", method: "llm" };
  } catch (error) {
    // On error, default to light (safer, faster)
    console.error("[intent-classifier] LLM classification error:", error);
    return {
      intent: "light",
      confidence: 0.5,
      reason: `LLM error, defaulting to light: ${String(error)}`,
      method: "llm",
    };
  }
}

/**
 * Main classification function: tries heuristics first, then LLM
 */
export async function classifyIntent(
  message: string,
  config?: IntentClassifierConfig,
): Promise<ClassificationResult> {
  // Skip if disabled
  if (config?.enabled === false) {
    return { intent: "light", confidence: 1.0, reason: "Classifier disabled", method: "heuristic" };
  }

  // Try quick heuristics first
  const quickResult = quickClassify(message, config);
  if (quickResult) {
    return quickResult;
  }

  // Fall back to LLM for ambiguous cases
  return llmClassify(message, config);
}

/**
 * Force heavy classification (for /code prefix or similar)
 */
export function forceHeavy(reason: string): ClassificationResult {
  return { intent: "heavy", confidence: 1.0, reason, method: "heuristic" };
}

/**
 * Force light classification (for /quick prefix or similar)
 */
export function forceLight(reason: string): ClassificationResult {
  return { intent: "light", confidence: 1.0, reason, method: "heuristic" };
}
