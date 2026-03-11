/**
 * Daily Log Writer for Triple-Layer Memory System
 *
 * Writes interaction logs to daily JSONL files for later retrieval and analysis.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getChildLogger } from "../logging.js";

const logger = getChildLogger({ module: "daily-log" });

export type DailyLogEntry = {
  timestamp: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  brainTarget?: "light" | "heavy";
  metadata?: {
    model?: string;
    tokens?: number;
    tools?: string[];
    channel?: string;
    classification?: {
      intent: string;
      confidence: number;
      reason: string;
    };
  };
};

export type DailyLogConfig = {
  /** Base directory for daily logs (default: ~/.clawdbot/memory/daily) */
  baseDir: string;
  /** Number of days to retain logs (default: 30) */
  retentionDays?: number;
  /** Whether logging is enabled (default: true) */
  enabled?: boolean;
};

/**
 * Get the log file path for a specific date
 */
function getLogPath(baseDir: string, date: Date): string {
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(baseDir, `${dateStr}.jsonl`);
}

/**
 * Ensure the log directory exists
 */
async function ensureLogDir(baseDir: string): Promise<void> {
  try {
    await fs.mkdir(baseDir, { recursive: true });
  } catch (error) {
    // Ignore if already exists
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Write a log entry to today's log file
 */
export async function writeDailyLog(entry: DailyLogEntry, config: DailyLogConfig): Promise<void> {
  if (config.enabled === false) {
    return;
  }

  try {
    await ensureLogDir(config.baseDir);
    const logPath = getLogPath(config.baseDir, new Date());
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(logPath, line, "utf-8");
    logger.debug({ logPath, role: entry.role }, "Daily log entry written");
  } catch (error) {
    logger.error({ error }, "Failed to write daily log entry");
  }
}

/**
 * Read log entries for a specific date
 */
export async function readDailyLog(date: Date, config: DailyLogConfig): Promise<DailyLogEntry[]> {
  const logPath = getLogPath(config.baseDir, date);
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as DailyLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // No log for this date
    }
    logger.error({ error, date }, "Failed to read daily log");
    return [];
  }
}

/**
 * Read logs for the last N days
 */
export async function readRecentLogs(
  days: number,
  config: DailyLogConfig,
): Promise<DailyLogEntry[]> {
  const entries: DailyLogEntry[] = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayEntries = await readDailyLog(date, config);
    entries.push(...dayEntries);
  }

  return entries.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Summarize recent logs for context injection
 */
export async function summarizeRecentLogs(
  days: number,
  config: DailyLogConfig,
  maxEntries: number = 20,
): Promise<string> {
  const entries = await readRecentLogs(days, config);
  if (entries.length === 0) {
    return "";
  }

  // Take most recent entries
  const recent = entries.slice(-maxEntries);

  const lines: string[] = [];
  for (const entry of recent) {
    const time = entry.timestamp.slice(11, 16); // HH:MM
    const date = entry.timestamp.slice(0, 10);
    const prefix = entry.role === "user" ? "U" : "A";
    const brain = entry.brainTarget ? ` [${entry.brainTarget}]` : "";
    const contentPreview = entry.content.slice(0, 100).replace(/\n/g, " ");
    lines.push(`[${date} ${time}] ${prefix}${brain}: ${contentPreview}...`);
  }

  return lines.join("\n");
}

/**
 * Prune logs older than retention period
 */
export async function pruneOldLogs(config: DailyLogConfig): Promise<number> {
  const retentionDays = config.retentionDays ?? 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  let pruned = 0;

  try {
    const files = await fs.readdir(config.baseDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }

      const dateStr = file.replace(".jsonl", "");
      const fileDate = new Date(dateStr);

      if (fileDate < cutoffDate) {
        const filePath = path.join(config.baseDir, file);
        await fs.unlink(filePath);
        pruned++;
        logger.info({ file }, "Pruned old daily log");
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to prune old logs");
  }

  return pruned;
}

/**
 * Create a DailyLogWriter instance for convenient logging
 */
export class DailyLogWriter {
  private readonly config: DailyLogConfig;

  constructor(config: DailyLogConfig) {
    this.config = config;
  }

  async write(entry: Omit<DailyLogEntry, "timestamp">): Promise<void> {
    await writeDailyLog(
      {
        ...entry,
        timestamp: new Date().toISOString(),
      },
      this.config,
    );
  }

  async readRecent(days: number): Promise<DailyLogEntry[]> {
    return readRecentLogs(days, this.config);
  }

  async summarize(days: number, maxEntries?: number): Promise<string> {
    return summarizeRecentLogs(days, this.config, maxEntries);
  }

  async prune(): Promise<number> {
    return pruneOldLogs(this.config);
  }
}
