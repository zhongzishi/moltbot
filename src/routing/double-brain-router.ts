/**
 * Double Brain Router
 *
 * Routes incoming messages to either:
 * - Light Brain (Gemini via Antigravity): Quick Q&A, lookups, simple tasks
 * - Heavy Brain (Claude): Coding, refactoring, complex reasoning
 */

import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DoubleBrainConfig } from "../config/types.routing.js";
import { loadMemoryContext, formatMemoryContextForPrompt } from "../memory/context-loader.js";
import {
  classifyIntent,
  forceHeavy,
  forceLight,
  type ClassificationResult,
} from "./intent-classifier.js";
import { callLightBrain, buildLightBrainSystemPrompt } from "./light-brain.js";

export type DoubleBrainResult =
  | { handled: false; reason: string }
  | {
      handled: true;
      reply: ReplyPayload;
      classification: ClassificationResult;
      brain: "light" | "heavy";
    };

/**
 * Check if double-brain routing is enabled
 */
export function isDoubleBrainEnabled(cfg: OpenClawConfig): boolean {
  return cfg.routing?.doubleBrain?.enabled === true;
}

/**
 * Get double-brain config from OpenClawConfig
 */
export function getDoubleBrainConfig(cfg: OpenClawConfig): DoubleBrainConfig | undefined {
  return cfg.routing?.doubleBrain;
}

/**
 * Check if message contains system instructions that require heavy brain
 */
function hasSystemInstructions(message: string): boolean {
  // System instructions injected by the platform (e.g., Feishu permission errors)
  // These require Claude to handle properly
  return message.includes("[System:") || message.includes("[system:");
}

/**
 * Check for force prefix overrides
 */
function checkForcePrefix(
  message: string,
  config: DoubleBrainConfig,
): { forced: boolean; intent: "light" | "heavy" | null; cleanedMessage: string } {
  const forceHeavyPrefix = config.overrides?.forceHeavyPrefix ?? "/code";
  const forceLightPrefix = config.overrides?.forceLightPrefix ?? "/quick";

  const trimmedMessage = message.trim();

  // System instructions always go to heavy brain
  if (hasSystemInstructions(trimmedMessage)) {
    return {
      forced: true,
      intent: "heavy",
      cleanedMessage: trimmedMessage,
    };
  }

  if (trimmedMessage.startsWith(forceHeavyPrefix)) {
    return {
      forced: true,
      intent: "heavy",
      cleanedMessage: trimmedMessage.slice(forceHeavyPrefix.length).trim(),
    };
  }

  if (trimmedMessage.startsWith(forceLightPrefix)) {
    return {
      forced: true,
      intent: "light",
      cleanedMessage: trimmedMessage.slice(forceLightPrefix.length).trim(),
    };
  }

  return { forced: false, intent: null, cleanedMessage: message };
}

/**
 * Route message through double-brain system
 *
 * @returns DoubleBrainResult indicating whether the message was handled by light brain
 */
export async function routeDoubleBrain(params: {
  message: string;
  cfg: OpenClawConfig;
  sessionKey?: string;
  userName?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<DoubleBrainResult> {
  const { message, cfg, sessionKey, userName, conversationHistory } = params;
  const doubleBrainConfig = getDoubleBrainConfig(cfg);

  // Check if enabled
  if (!doubleBrainConfig?.enabled) {
    return { handled: false, reason: "Double-brain routing disabled" };
  }

  // Check for force prefix overrides
  const prefixCheck = checkForcePrefix(message, doubleBrainConfig);
  let classification: ClassificationResult;
  let messageToProcess = message;

  if (prefixCheck.forced) {
    messageToProcess = prefixCheck.cleanedMessage;
    if (prefixCheck.intent === "heavy") {
      classification = forceHeavy(
        `User used ${doubleBrainConfig.overrides?.forceHeavyPrefix ?? "/code"} prefix`,
      );
    } else {
      classification = forceLight(
        `User used ${doubleBrainConfig.overrides?.forceLightPrefix ?? "/quick"} prefix`,
      );
    }
  } else {
    // Classify intent
    classification = await classifyIntent(message, doubleBrainConfig.intentClassifier);
  }

  // If heavy, don't handle here - let the normal flow continue
  if (classification.intent === "heavy") {
    return { handled: false, reason: `Routed to heavy brain: ${classification.reason}` };
  }

  // Handle with light brain (Gemini)
  try {
    // Load memory context if available
    let memoryContext: Awaited<ReturnType<typeof loadMemoryContext>> | undefined;
    if (cfg.memory?.tripleLayer?.enabled) {
      try {
        memoryContext = await loadMemoryContext({
          config: cfg.memory.tripleLayer,
          query: message,
        });
      } catch (err) {
        console.warn("[double-brain] Failed to load memory context:", err);
      }
    }

    // Build system prompt with memory
    const formattedMemory = memoryContext ? formatMemoryContextForPrompt(memoryContext) : undefined;
    const systemPrompt = buildLightBrainSystemPrompt({
      soulContent: memoryContext?.soul,
      memoryContent: formattedMemory,
      userName,
    });

    // Call Gemini via light brain
    const response = await callLightBrain(
      {
        message: messageToProcess,
        systemPrompt,
        conversationHistory,
        maxTokens: 4096,
      },
      doubleBrainConfig.lightBrain,
    );

    // Format response as ReplyPayload
    // Add a subtle indicator that this came from light brain
    const brainIndicator = `\n\n_[via ${response.model}]_`;
    const reply: ReplyPayload = {
      text: response.text + brainIndicator,
    };

    return {
      handled: true,
      reply,
      classification,
      brain: "light",
    };
  } catch (error) {
    // On light brain error, fall back to heavy brain
    console.error("[double-brain] Light brain error, falling back to heavy:", error);
    return {
      handled: false,
      reason: `Light brain error: ${error}. Falling back to heavy brain.`,
    };
  }
}

/**
 * Log double-brain routing decision
 */
export function logRoutingDecision(params: {
  sessionKey?: string;
  message: string;
  classification: ClassificationResult;
  brain: "light" | "heavy";
}): void {
  const truncatedMessage =
    params.message.length > 50 ? params.message.slice(0, 50) + "..." : params.message;
  console.log(
    `[double-brain] session=${params.sessionKey ?? "unknown"} ` +
      `brain=${params.brain} intent=${params.classification.intent} ` +
      `confidence=${params.classification.confidence.toFixed(2)} ` +
      `method=${params.classification.method} ` +
      `reason="${params.classification.reason}" ` +
      `message="${truncatedMessage}"`,
  );
}
