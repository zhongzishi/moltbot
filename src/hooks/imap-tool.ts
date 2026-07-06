/**
 * IMAP tool for agent - allows users to add email monitoring via chat.
 */

import { Type } from "typebox";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import type { HooksImapAccountConfig } from "../config/types.hooks.js";
import { getChildLogger } from "../logging.js";
import {
  deleteImapCredential,
  hasImapCredentialSync,
  saveImapCredential,
} from "./imap-credentials.js";
import { discoverImapSettings } from "./imap-discovery.js";
import {
  ImapWatcher,
  isImapWatcherRunning,
  startSingleImapWatcher,
  stopSingleImapWatcher,
} from "./imap-watcher.js";
import {
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_PORT,
  DEFAULT_IMAP_SECURE,
  getImapPreset,
  validateImapAccountConfig,
} from "./imap.js";

const logger = getChildLogger({ module: "imap-tool" });

// Tool schemas
export const AddImapMonitorSchema = Type.Object({
  email: Type.String({ description: "Email address to monitor (e.g. user@gmail.com)" }),
  password: Type.String({ description: "App password or authorization code for IMAP access" }),
  host: Type.Optional(
    Type.String({ description: "IMAP server host (auto-detected if not provided)" }),
  ),
  port: Type.Optional(Type.Number({ description: "IMAP server port (default: 993)" })),
});

export const RemoveImapMonitorSchema = Type.Object({
  email: Type.String({ description: "Email address to stop monitoring" }),
});

export const ListImapMonitorsSchema = Type.Object({});

export type AddImapMonitorInput = {
  email: string;
  password: string;
  host?: string;
  port?: number;
  /** Owner identifier (e.g., Feishu open_id) for credential encryption. */
  ownerId: string;
};

export type RemoveImapMonitorInput = {
  email: string;
};

/**
 * Add an IMAP email monitor.
 * Called by agent when user wants to monitor their email.
 */
export async function addImapMonitor(input: AddImapMonitorInput): Promise<string> {
  const email = input.email.trim().toLowerCase();

  // Validate email format
  if (!email.includes("@")) {
    return `Invalid email address: ${input.email}`;
  }

  // Get IMAP settings
  let host = input.host;
  let port = input.port;
  let secure = DEFAULT_IMAP_SECURE;

  if (!host) {
    // Try to auto-detect
    const discovered = await discoverImapSettings(email);
    if (discovered) {
      host = discovered.host;
      port = discovered.port;
      secure = discovered.secure;
      logger.info({ email, host, source: discovered.source }, "auto-detected IMAP settings");
    } else {
      // Check preset
      const preset = getImapPreset(email);
      if (preset) {
        host = preset.host;
        port = preset.port;
        secure = preset.secure;
      } else {
        return `Could not detect IMAP settings for ${email}. Please provide the IMAP host.`;
      }
    }
  }

  port = port ?? DEFAULT_IMAP_PORT;

  // Build account config
  const accountConfig: HooksImapAccountConfig = {
    email,
    host,
    port,
    secure,
    mailbox: DEFAULT_IMAP_MAILBOX,
  };

  // Validate config
  const validation = validateImapAccountConfig(accountConfig);
  if (!validation.ok) {
    return `Configuration error: ${validation.error}`;
  }

  // Test connection before saving (without entering IDLE loop)
  try {
    const testWatcher = new ImapWatcher(
      {
        email,
        host,
        port,
        secure,
        mailbox: DEFAULT_IMAP_MAILBOX,
      },
      input.password,
      { autoReconnect: false },
    );

    await testWatcher.testConnection();
  } catch (err) {
    logger.error({ email, err }, "IMAP connection test failed");
    return `Connection failed: ${(err as Error).message}. Please check your email and password.`;
  }

  // Save credentials (encrypted with owner's ID)
  await saveImapCredential(email, input.password, input.ownerId);
  logger.info({ email, ownerId: input.ownerId }, "saved IMAP credentials");

  // Update config
  const cfg = loadConfig();
  const existingAccounts = cfg.hooks?.imap?.accounts ?? [];

  // Remove existing account with same email if any
  const filteredAccounts = existingAccounts.filter((a) => a.email.toLowerCase() !== email);

  // Add new account
  filteredAccounts.push(accountConfig);

  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.enabled = true;
  cfg.hooks.imap = cfg.hooks.imap ?? {};
  cfg.hooks.imap.accounts = filteredAccounts;

  await writeConfigFile(cfg);
  logger.info({ email }, "added IMAP account to config");

  // Try to start the watcher immediately if gateway is running
  const dynamicStart = await startSingleImapWatcher(
    {
      email,
      host,
      port,
      secure,
      mailbox: DEFAULT_IMAP_MAILBOX,
    },
    input.password,
  );

  if (dynamicStart.started) {
    return `Successfully added email monitor for ${email}. Monitoring is now active - new emails will be forwarded to you immediately.`;
  }

  // Watcher couldn't start dynamically (maybe gateway not running)
  return `Successfully added email monitor for ${email}. New emails will be forwarded when gateway starts.`;
}

/**
 * Remove an IMAP email monitor.
 */
export async function removeImapMonitor(input: RemoveImapMonitorInput): Promise<string> {
  const email = input.email.trim().toLowerCase();

  // Remove from config
  const cfg = loadConfig();
  const accounts = cfg.hooks?.imap?.accounts ?? [];
  const index = accounts.findIndex((a) => a.email.toLowerCase() === email);

  if (index === -1) {
    return `No email monitor found for ${email}`;
  }

  accounts.splice(index, 1);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.imap = cfg.hooks.imap ?? {};
  cfg.hooks.imap.accounts = accounts;

  await writeConfigFile(cfg);

  // Delete credentials
  await deleteImapCredential(email);

  // Stop the watcher if running
  await stopSingleImapWatcher(email);

  logger.info({ email }, "removed IMAP monitor");

  return `Removed email monitor for ${email}`;
}

/**
 * List all IMAP email monitors.
 */
export async function listImapMonitors(): Promise<string> {
  const cfg = loadConfig();
  const accounts = cfg.hooks?.imap?.accounts ?? [];

  if (accounts.length === 0) {
    return "No email monitors configured.";
  }

  const lines: string[] = ["Email monitors:"];
  for (const account of accounts) {
    const hasCreds = hasImapCredentialSync(account.email);
    const isRunning = isImapWatcherRunning(account.email);
    let status: string;
    if (isRunning) {
      status = "active";
    } else if (hasCreds) {
      status = "configured (not running)";
    } else {
      status = "missing credentials";
    }
    lines.push(`- ${account.email} (${account.host}:${account.port}) [${status}]`);
  }

  return lines.join("\n");
}

/**
 * Tool definitions for agent registration.
 */
export const imapTools = {
  add_email_monitor: {
    name: "add_email_monitor",
    description:
      "Add email monitoring for a user. When new emails arrive, they will be forwarded to the user.",
    schema: AddImapMonitorSchema,
    handler: addImapMonitor,
  },
  remove_email_monitor: {
    name: "remove_email_monitor",
    description: "Remove email monitoring for a user.",
    schema: RemoveImapMonitorSchema,
    handler: removeImapMonitor,
  },
  list_email_monitors: {
    name: "list_email_monitors",
    description: "List all configured email monitors.",
    schema: ListImapMonitorsSchema,
    handler: listImapMonitors,
  },
};
