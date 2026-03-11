/**
 * Double-Brain Routing Configuration Types
 *
 * Defines configuration for the dual-brain architecture:
 * - Light brain: Gemini 3 via Antigravity Proxy for quick tasks
 * - Heavy brain: Claude Code CLI for coding tasks
 */

import type { IntentClassifierConfig } from "../routing/intent-classifier.js";

export type LightBrainConfig = {
  /** Model provider ID (e.g., "antigravity") */
  provider?: string;
  /** Model ID (e.g., "gemini-3-flash") */
  model?: string;
  /** Base URL for the provider (e.g., "http://localhost:8080") */
  baseUrl?: string;
};

export type HeavyBrainConfig = {
  /** Type of heavy brain: "claude-code" or "embedded" */
  type?: "claude-code" | "embedded";
  /** Path to Claude Code CLI (default: "claude") */
  cliPath?: string;
  /** Timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Working directory for Claude Code */
  workspaceDir?: string;
};

export type DoubleBrainConfig = {
  /** Whether double-brain routing is enabled */
  enabled?: boolean;
  /** Intent classifier configuration */
  intentClassifier?: IntentClassifierConfig;
  /** Light brain (Gemini) configuration */
  lightBrain?: LightBrainConfig;
  /** Heavy brain (Claude Code) configuration */
  heavyBrain?: HeavyBrainConfig;
  /** Manual override prefixes */
  overrides?: {
    /** Prefix to force heavy brain (e.g., "/code") */
    forceHeavyPrefix?: string;
    /** Prefix to force light brain (e.g., "/quick") */
    forceLightPrefix?: string;
  };
};

export type DoubleBrainRoutingConfig = {
  /** Double-brain routing configuration */
  doubleBrain?: DoubleBrainConfig;
};

/**
 * Get default double-brain configuration
 */
export function getDefaultDoubleBrainConfig(): DoubleBrainConfig {
  return {
    enabled: false, // Disabled by default, user must opt-in
    intentClassifier: {
      enabled: true,
      baseUrl: "http://localhost:8080",
      model: "gemini-3-flash",
    },
    lightBrain: {
      provider: "antigravity",
      model: "gemini-3-flash",
      baseUrl: "http://localhost:8080",
    },
    heavyBrain: {
      type: "claude-code",
      cliPath: "claude",
      timeoutMs: 300000,
    },
    overrides: {
      forceHeavyPrefix: "/code",
      forceLightPrefix: "/quick",
    },
  };
}
