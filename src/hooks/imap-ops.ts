/**
 * IMAP CLI operations: setup, run, status.
 */

import * as prompts from "@clack/prompts";

import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { info, success, warn, danger } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { HooksImapAccountConfig } from "../config/types.hooks.js";

import {
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_PORT,
  DEFAULT_IMAP_SECURE,
  getEmailDomain,
  getImapPreset,
  resolveImapAccountConfig,
  validateImapAccountConfig,
} from "./imap.js";
import { discoverImapSettings, getImapSetupHelp } from "./imap-discovery.js";
import {
  deleteImapCredential,
  hasImapCredentialSync,
  loadImapCredential,
  saveImapCredential,
} from "./imap-credentials.js";
import { createImapWatcher, type ImapEmail, type ImapWatcher } from "./imap-watcher.js";

const logger = getChildLogger({ module: "imap-ops" });

export type ImapSetupOptions = {
  email?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
};

/**
 * Interactive IMAP setup.
 */
export async function imapSetup(
  opts: ImapSetupOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<boolean> {
  runtime.log(info("IMAP Email Watcher Setup"));
  runtime.log("");

  // 1. Get email address
  let email = opts.email;
  if (!email) {
    const result = await prompts.text({
      message: "Email address:",
      placeholder: "user@example.com",
      validate: (value) => {
        if (!value.includes("@")) return "Please enter a valid email address";
        return undefined;
      },
    });
    if (prompts.isCancel(result)) return false;
    email = result;
  }

  email = email.trim().toLowerCase();
  const domain = getEmailDomain(email);

  // 2. Detect or prompt for IMAP settings
  let host = opts.host;
  let port = opts.port;
  let secure = opts.secure;

  if (!host) {
    // Try preset first
    const preset = getImapPreset(email);
    if (preset) {
      runtime.log(info(`Detected settings for ${domain}:`));
      runtime.log(`  Host: ${preset.host}`);
      runtime.log(`  Port: ${preset.port}`);
      runtime.log(`  Secure: ${preset.secure ? "Yes (TLS)" : "No"}`);
      host = preset.host;
      port = preset.port;
      secure = preset.secure;
    } else {
      // Try auto-discovery
      runtime.log(info(`Discovering IMAP settings for ${domain}...`));
      const discovered = await discoverImapSettings(email);

      if (discovered) {
        runtime.log(success(`Found: ${discovered.host}:${discovered.port} (${discovered.source})`));
        host = discovered.host;
        port = discovered.port;
        secure = discovered.secure;
      } else {
        runtime.log(warn("Could not auto-detect IMAP settings. Please enter manually."));

        const hostResult = await prompts.text({
          message: "IMAP host:",
          placeholder: `imap.${domain}`,
        });
        if (prompts.isCancel(hostResult)) return false;
        host = hostResult;

        const portResult = await prompts.text({
          message: "IMAP port:",
          initialValue: "993",
          validate: (value) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n < 1 || n > 65535) return "Invalid port";
            return undefined;
          },
        });
        if (prompts.isCancel(portResult)) return false;
        port = parseInt(portResult, 10);

        const secureResult = await prompts.confirm({
          message: "Use TLS/SSL?",
          initialValue: true,
        });
        if (prompts.isCancel(secureResult)) return false;
        secure = secureResult;
      }
    }
  }

  // 3. Show auth help
  const help = getImapSetupHelp(email);
  runtime.log("");
  runtime.log(info(`Authentication: ${help.authType}`));
  if (help.helpText) {
    runtime.log(`  ${help.helpText}`);
  }
  if (help.helpUrl) {
    runtime.log(`  More info: ${help.helpUrl}`);
  }
  runtime.log("");

  // 4. Get password/app password
  let password = opts.password;
  if (!password) {
    const result = await prompts.password({
      message: help.authType.includes("App") ? "App password / Authorization code:" : "Password:",
    });
    if (prompts.isCancel(result)) return false;
    password = result;
  }

  // 5. Verify connection
  runtime.log("");
  runtime.log(info("Verifying connection..."));

  const accountConfig: HooksImapAccountConfig = {
    email,
    host: host!,
    port: port ?? DEFAULT_IMAP_PORT,
    secure: secure ?? DEFAULT_IMAP_SECURE,
    mailbox: opts.mailbox ?? DEFAULT_IMAP_MAILBOX,
  };

  const validation = validateImapAccountConfig(accountConfig);
  if (!validation.ok) {
    runtime.log(danger(`Validation error: ${validation.error}`));
    return false;
  }

  // Test connection
  try {
    const runtimeConfig = resolveImapAccountConfig(accountConfig);
    const testWatcher = new (await import("./imap-watcher.js")).ImapWatcher(
      runtimeConfig,
      password,
      { autoReconnect: false },
    );

    await testWatcher.start();
    await testWatcher.stop();
    runtime.log(success("Connection successful!"));
  } catch (err) {
    runtime.log(danger(`Connection failed: ${(err as Error).message}`));
    return false;
  }

  // 6. Save credentials
  // CLI setup uses "cli-local" as owner ID (stable across restarts)
  // Agent tool uses the Feishu user's open_id
  runtime.log(info("Saving credentials..."));
  await saveImapCredential(email, password, "cli-local");

  // 7. Update config
  const cfg = loadConfig();
  const existingAccounts = cfg.hooks?.imap?.accounts ?? [];

  // Remove existing account with same email if any
  const filteredAccounts = existingAccounts.filter(
    (a) => a.email.toLowerCase() !== email.toLowerCase(),
  );

  // Add new account
  filteredAccounts.push(accountConfig);

  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.imap = cfg.hooks.imap ?? {};
  cfg.hooks.imap.accounts = filteredAccounts;

  await writeConfigFile(cfg);
  runtime.log(success(`Added IMAP account: ${email}`));

  return true;
}

/**
 * List configured IMAP accounts.
 */
export async function imapStatus(runtime: RuntimeEnv = defaultRuntime): Promise<void> {
  const cfg = loadConfig();
  const accounts = cfg.hooks?.imap?.accounts ?? [];

  if (accounts.length === 0) {
    runtime.log(info("No IMAP accounts configured."));
    runtime.log(`Run ${info("clawdbot webhooks imap setup")} to add one.`);
    return;
  }

  runtime.log(info(`IMAP Accounts (${accounts.length}):`));
  runtime.log("");

  for (const account of accounts) {
    const hasCreds = hasImapCredentialSync(account.email);
    const status = hasCreds ? success("[ready]") : warn("[no credentials]");

    runtime.log(`  ${account.email} ${status}`);
    runtime.log(`    Host: ${account.host}:${account.port}`);
    runtime.log(`    Mailbox: ${account.mailbox ?? DEFAULT_IMAP_MAILBOX}`);
    runtime.log("");
  }
}

/**
 * Remove an IMAP account.
 */
export async function imapRemove(
  email: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<boolean> {
  const cfg = loadConfig();
  const accounts = cfg.hooks?.imap?.accounts ?? [];

  const normalizedEmail = email.trim().toLowerCase();
  const index = accounts.findIndex((a) => a.email.toLowerCase() === normalizedEmail);

  if (index === -1) {
    runtime.log(warn(`Account not found: ${email}`));
    return false;
  }

  // Remove from config
  accounts.splice(index, 1);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.imap = cfg.hooks.imap ?? {};
  cfg.hooks.imap.accounts = accounts;
  await writeConfigFile(cfg);

  // Delete credentials
  await deleteImapCredential(email);

  runtime.log(success(`Removed IMAP account: ${email}`));
  return true;
}

// Active watchers for run command
const activeWatchers: Map<string, ImapWatcher> = new Map();

export type ImapRunOptions = {
  /** Callback when new email arrives */
  onEmail?: (email: ImapEmail, accountEmail: string) => void | Promise<void>;
};

/**
 * Run IMAP watchers for all configured accounts.
 */
export async function imapRun(
  opts: ImapRunOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const cfg = loadConfig();
  const accounts = cfg.hooks?.imap?.accounts ?? [];

  if (accounts.length === 0) {
    runtime.log(warn("No IMAP accounts configured."));
    return;
  }

  runtime.log(info(`Starting IMAP watchers for ${accounts.length} account(s)...`));

  const defaults = {
    model: cfg.hooks?.imap?.model,
    thinking: cfg.hooks?.imap?.thinking,
  };

  for (const account of accounts) {
    const runtimeConfig = resolveImapAccountConfig(account, defaults);

    // Check credentials
    const creds = await loadImapCredential(account.email);
    if (!creds) {
      logger.warn({ email: account.email }, "no credentials, skipping");
      runtime.log(warn(`Skipping ${account.email}: no credentials`));
      continue;
    }

    try {
      const watcher = await createImapWatcher(runtimeConfig);

      watcher.on("email", async (email) => {
        logger.info(
          { email: account.email, from: email.from, subject: email.subject },
          "new email",
        );
        if (opts.onEmail) {
          await opts.onEmail(email, account.email);
        }
      });

      watcher.on("error", (err) => {
        logger.error({ email: account.email, err }, "watcher error");
      });

      watcher.on("connected", () => {
        runtime.log(success(`Connected: ${account.email}`));
      });

      watcher.on("disconnected", () => {
        runtime.log(warn(`Disconnected: ${account.email}`));
      });

      watcher.on("reconnecting", (attempt) => {
        runtime.log(info(`Reconnecting ${account.email} (attempt ${attempt})...`));
      });

      activeWatchers.set(account.email, watcher);
      runtime.log(success(`Started watcher: ${account.email}`));
    } catch (err) {
      logger.error({ email: account.email, err }, "failed to start watcher");
      runtime.log(danger(`Failed to start ${account.email}: ${(err as Error).message}`));
    }
  }

  if (activeWatchers.size === 0) {
    runtime.log(warn("No watchers started."));
    return;
  }

  runtime.log(info(`${activeWatchers.size} watcher(s) running. Press Ctrl+C to stop.`));

  // Handle graceful shutdown
  const shutdown = async () => {
    runtime.log(info("Shutting down IMAP watchers..."));
    for (const [email, watcher] of activeWatchers) {
      await watcher.stop();
      runtime.log(info(`Stopped: ${email}`));
    }
    activeWatchers.clear();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process running
  await new Promise(() => {});
}

/**
 * Stop all running IMAP watchers.
 */
export async function imapStop(): Promise<void> {
  for (const [email, watcher] of activeWatchers) {
    await watcher.stop();
    logger.info({ email }, "stopped watcher");
  }
  activeWatchers.clear();
}

/**
 * Get active watcher count.
 */
export function getActiveWatcherCount(): number {
  return activeWatchers.size;
}
