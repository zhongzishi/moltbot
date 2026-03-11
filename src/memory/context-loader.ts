/**
 * Memory Context Loader for Triple-Layer Memory System
 *
 * Loads SOUL.md, MEMORY.md, daily logs, and QMD semantic search results
 * for injection into the agent's system prompt.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChildLogger } from "../logging.js";
import { summarizeRecentLogs, type DailyLogConfig } from "./daily-log.js";

const logger = getChildLogger({ module: "context-loader" });

export type TripleLayerMemoryConfig = {
  /** Whether the triple-layer memory system is enabled */
  enabled?: boolean;
  /** Base path for memory files (default: ~/.clawdbot/memory) */
  basePath?: string;
  /** SOUL.md configuration */
  soul?: {
    enabled?: boolean;
    path?: string; // relative to basePath, default: SOUL.md
  };
  /** MEMORY.md (long-term memory) configuration */
  longTerm?: {
    enabled?: boolean;
    path?: string; // relative to basePath, default: MEMORY.md
    autoUpdate?: boolean;
  };
  /** Daily logs configuration */
  daily?: {
    enabled?: boolean;
    dir?: string; // relative to basePath, default: daily/
    retentionDays?: number;
    summarizeDays?: number; // days to include in summary, default: 3
  };
  /** QMD semantic search configuration */
  qmd?: {
    enabled?: boolean;
    maxResults?: number;
    minScore?: number;
  };
};

export type LoadedMemoryContext = {
  soul?: string;
  memory?: string;
  recentDaily?: string;
  qmdResults?: string;
};

/**
 * Expand ~ to home directory
 */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Safely read a file, returning null if it doesn't exist
 */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(expandPath(filePath), "utf-8");
    return content.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    logger.error({ error, filePath }, "Failed to read memory file");
    return null;
  }
}

/**
 * Run QMD semantic search
 */
async function runQmdSearch(
  query: string,
  maxResults: number = 5,
  minScore: number = 0.5,
): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["query", query, "-n", String(maxResults), "--min-score", String(minScore)];

    const child = spawn("qmd", args, {
      timeout: 10000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      logger.debug({ error }, "QMD not available or failed");
      resolve(null);
    });

    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        if (stderr) {
          logger.debug({ stderr }, "QMD search returned no results");
        }
        resolve(null);
      }
    });
  });
}

/**
 * Load all memory context layers
 */
export async function loadMemoryContext(params: {
  config?: TripleLayerMemoryConfig;
  query?: string; // Current user message for QMD search
  agentId?: string;
}): Promise<LoadedMemoryContext> {
  const config = params.config;
  if (!config?.enabled) {
    return {};
  }

  const basePath = expandPath(config.basePath ?? "~/.clawdbot/memory");
  const context: LoadedMemoryContext = {};

  // Load SOUL.md
  if (config.soul?.enabled !== false) {
    const soulPath = path.join(basePath, config.soul?.path ?? "SOUL.md");
    const soul = await safeReadFile(soulPath);
    if (soul) {
      context.soul = soul;
      logger.debug({ soulPath }, "Loaded SOUL.md");
    }
  }

  // Load MEMORY.md
  if (config.longTerm?.enabled !== false) {
    const memoryPath = path.join(basePath, config.longTerm?.path ?? "MEMORY.md");
    const memory = await safeReadFile(memoryPath);
    if (memory) {
      context.memory = memory;
      logger.debug({ memoryPath }, "Loaded MEMORY.md");
    }
  }

  // Load recent daily logs summary
  if (config.daily?.enabled !== false) {
    const dailyDir = path.join(basePath, config.daily?.dir ?? "daily");
    const dailyConfig: DailyLogConfig = {
      baseDir: dailyDir,
      retentionDays: config.daily?.retentionDays ?? 30,
    };
    const summarizeDays = config.daily?.summarizeDays ?? 3;
    const summary = await summarizeRecentLogs(summarizeDays, dailyConfig);
    if (summary) {
      context.recentDaily = summary;
      logger.debug({ summarizeDays }, "Loaded daily logs summary");
    }
  }

  // Run QMD semantic search if query provided
  if (config.qmd?.enabled !== false && params.query) {
    const qmdResults = await runQmdSearch(
      params.query,
      config.qmd?.maxResults ?? 5,
      config.qmd?.minScore ?? 0.5,
    );
    if (qmdResults) {
      context.qmdResults = qmdResults;
      logger.debug({ queryLength: params.query.length }, "QMD search completed");
    }
  }

  return context;
}

/**
 * Format loaded memory context for injection into system prompt
 */
export function formatMemoryContextForPrompt(context: LoadedMemoryContext): string {
  const sections: string[] = [];

  if (context.soul) {
    sections.push(`<soul>\n${context.soul}\n</soul>`);
  }

  if (context.memory) {
    sections.push(`<long_term_memory>\n${context.memory}\n</long_term_memory>`);
  }

  if (context.recentDaily) {
    sections.push(`<recent_interactions>\n${context.recentDaily}\n</recent_interactions>`);
  }

  if (context.qmdResults) {
    sections.push(`<relevant_context>\n${context.qmdResults}\n</relevant_context>`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `\n\n<!-- Triple-Layer Memory Context -->\n${sections.join("\n\n")}`;
}

/**
 * Convenience function to load and format memory context in one call
 */
export async function loadAndFormatMemoryContext(params: {
  config?: TripleLayerMemoryConfig;
  query?: string;
  agentId?: string;
}): Promise<string> {
  const context = await loadMemoryContext(params);
  return formatMemoryContextForPrompt(context);
}

/**
 * Get default memory configuration
 */
export function getDefaultMemoryConfig(): TripleLayerMemoryConfig {
  return {
    enabled: true,
    basePath: "~/.clawdbot/memory",
    soul: { enabled: true },
    longTerm: { enabled: true, autoUpdate: true },
    daily: { enabled: true, retentionDays: 30, summarizeDays: 3 },
    qmd: { enabled: true, maxResults: 5, minScore: 0.5 },
  };
}
