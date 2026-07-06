/**
 * IMAP watcher using IDLE for real-time email notifications.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow, type FetchMessageObject } from "imapflow";
// @ts-expect-error mailparser has no type declarations
import { simpleParser, type AddressObject } from "mailparser";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import { loadImapCredential } from "./imap-credentials.js";
import type { ImapAccountRuntimeConfig } from "./imap.js";

export type ImapEmail = {
  uid: number;
  messageId: string | undefined;
  date: Date | undefined;
  from: string | undefined;
  fromName: string | undefined;
  to: string[];
  subject: string | undefined;
  text: string | undefined;
  html: string | undefined;
  hasAttachments: boolean;
};

export type ImapWatcherEvents = {
  email: [email: ImapEmail];
  error: [error: Error];
  connected: [];
  disconnected: [];
  reconnecting: [attempt: number];
};

export type ImapWatcherOptions = {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 5000) */
  reconnectDelayMs?: number;
  /** Max reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
  /** IDLE timeout in ms before re-entering IDLE (default: 25 * 60 * 1000 = 25min) */
  idleTimeoutMs?: number;
  /** Poll interval in ms as fallback for unreliable IDLE (default: 60000 = 1min) */
  pollIntervalMs?: number;
};

const DEFAULT_OPTIONS: Required<ImapWatcherOptions> = {
  autoReconnect: true,
  reconnectDelayMs: 5000,
  maxReconnectAttempts: Infinity,
  idleTimeoutMs: 60 * 1000, // 60 seconds - exit IDLE periodically for polling
  pollIntervalMs: 60 * 1000, // Poll every 60 seconds as fallback for unreliable IDLE
};

export class ImapWatcher extends EventEmitter<ImapWatcherEvents> {
  private client: ImapFlow | null = null;
  private config: ImapAccountRuntimeConfig;
  private password: string;
  private options: Required<ImapWatcherOptions>;
  private logger: ReturnType<typeof getChildLogger>;
  private shuttingDown = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastSeenUid = 0;

  constructor(
    config: ImapAccountRuntimeConfig,
    password: string,
    options: ImapWatcherOptions = {},
  ) {
    super();
    this.config = config;
    this.password = password;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.logger = getChildLogger({ module: "imap-watcher", email: config.email });
  }

  /**
   * Create an ImapWatcher from config, loading credentials automatically.
   */
  static async fromConfig(
    config: ImapAccountRuntimeConfig,
    options?: ImapWatcherOptions,
  ): Promise<ImapWatcher> {
    const creds = await loadImapCredential(config.email);
    if (!creds) {
      throw new Error(`No credentials found for ${config.email}`);
    }
    return new ImapWatcher(config, creds.password, options);
  }

  /**
   * Start watching for new emails.
   */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error("Watcher is shutting down");
    }
    await this.connect();
  }

  /**
   * Test connection without entering IDLE loop.
   * Use this to validate credentials before saving config.
   */
  async testConnection(): Promise<void> {
    this.logger.info({ host: this.config.host, port: this.config.port }, "testing IMAP connection");

    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.email,
        pass: this.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      this.logger.info("IMAP connection test successful");
      await client.logout();
    } catch (err) {
      this.logger.error({ err }, "IMAP connection test failed");
      throw err;
    }
  }

  /**
   * Stop watching and disconnect.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.clearReconnectTimer();

    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // Ignore logout errors
      }
      this.client = null;
    }

    this.emit("disconnected");
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this.client?.usable ?? false;
  }

  /** Destroy old client before creating a new one to prevent connection leaks. */
  private destroyClient(): void {
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.close();
      } catch {
        // ignore cleanup errors
      }
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    const tag = `[imap:${this.config.email}]`;
    if (this.shuttingDown) {
      return;
    }
    // Prevent re-entrant connect (close events from old client can trigger scheduleReconnect
    // while a new connect() is already in progress).
    if (this.connecting) {
      console.log(tag, "connect() skipped — already connecting");
      return;
    }
    this.connecting = true;

    console.log(tag, "connect() called");
    console.log(tag, "connecting to", this.config.host, this.config.port);
    this.logger.info({ host: this.config.host, port: this.config.port }, "connecting to IMAP");

    try {
      // Clean up any previous client to avoid leaked connections
      this.destroyClient();

      console.log(tag, "creating ImapFlow client...");
      this.client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: {
          user: this.config.email,
          pass: this.password,
        },
        logger: false, // Disable imapflow's built-in logger
        maxIdleTime: this.options.idleTimeoutMs,
      });
      console.log(tag, "ImapFlow client created");

      // Handle connection close — only schedule reconnect if we're not already
      // inside a connect() call (prevents the race where the old client's close
      // event fires while the new client is being set up).
      this.client.on("close", () => {
        console.log(tag, "connection closed");
        if (!this.shuttingDown && !this.connecting) {
          this.logger.warn("IMAP connection closed unexpectedly");
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });

      this.client.on("error", (err: Error) => {
        console.log(tag, "client error:", err.message);
        this.logger.error({ err }, "IMAP error");
        this.emit("error", err);
      });

      console.log(tag, "calling client.connect()...");
      await this.client.connect();
      console.log(tag, "client.connect() returned");
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.emit("connected");
      console.log(tag, "emitted connected event");
      this.logger.info("connected to IMAP");

      // Start watching
      console.log(tag, "calling watchMailbox()...");
      await this.watchMailbox();
      console.log(tag, "watchMailbox() returned");
    } catch (err) {
      this.connecting = false;
      this.logger.error({ err }, "failed to connect to IMAP");
      this.emit("error", err as Error);
      this.scheduleReconnect();
    }
  }

  private async watchMailbox(): Promise<void> {
    const tag = `[imap:${this.config.email}]`;
    console.log(tag, "watchMailbox() called");
    if (!this.client || this.shuttingDown) {
      return;
    }

    console.log(tag, "getting mailbox lock...");
    const lock = await this.client.getMailboxLock(this.config.mailbox);
    console.log(tag, "got mailbox lock");

    try {
      // Get initial message count
      const mailbox = this.client.mailbox;
      if (mailbox) {
        this.lastSeenUid = mailbox.uidNext ? mailbox.uidNext - 1 : 0;
        console.log(tag, "mailbox opened, lastUid:", this.lastSeenUid, "exists:", mailbox.exists);
        this.logger.info(
          { mailbox: this.config.mailbox, messageCount: mailbox.exists, lastUid: this.lastSeenUid },
          "mailbox opened",
        );
      }

      // Flag to track if new messages arrived during IDLE
      let pendingFetch = false;

      // Listen for new messages
      // Note: On EXISTS event, we set pendingFetch flag and break IDLE using NOOP.
      // Some IMAP servers (like QQ Enterprise Mail) don't allow FETCH during IDLE
      // and don't automatically end IDLE on EXISTS. The NOOP command interrupts IDLE
      // and allows the fetch to happen after IDLE returns.
      this.client.on("exists", (data: { prevCount: number; count: number }) => {
        console.log(tag, "EXISTS event:", data);
        if (data.count > data.prevCount) {
          console.log(tag, "new message(s) detected, breaking IDLE with NOOP");
          this.logger.debug({ prevCount: data.prevCount, count: data.count }, "new message(s)");
          pendingFetch = true;
          // Break IDLE by sending NOOP - this triggers preCheck() internally
          // which sends DONE to end IDLE, then executes NOOP
          this.client?.noop().catch((err: Error) => {
            console.log(tag, "NOOP error (expected during IDLE break):", err.message);
          });
        }
      });

      // Enter IDLE loop (maxIdleTime handles auto-restart)
      console.log(tag, "entering IDLE loop...");
      let rapidReturnCount = 0;
      const RAPID_RETURN_THRESHOLD_MS = 5000; // If IDLE returns in <5s, it's suspicious
      const MAX_RAPID_RETURNS = 3; // After 3 rapid returns, reconnect
      const pollIntervalMs = this.options.pollIntervalMs;
      console.log(tag, "poll interval:", pollIntervalMs, "ms");

      while (!this.shuttingDown && this.client?.usable) {
        try {
          // idle() returns when new data arrives or maxIdleTime expires
          // Use Promise.race to force timeout for polling (ImapFlow's maxIdleTime may not cause idle() to return)
          const idleStartMs = Date.now();
          const tag = `[imap:${this.config.email}]`;
          console.log(tag, "calling client.idle() with", pollIntervalMs, "ms timeout...");

          // Create a cancellable timeout promise
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            timeoutHandle = setTimeout(() => resolve("timeout"), pollIntervalMs);
          });

          // Race between IDLE and timeout
          const result = await Promise.race([
            this.client.idle().then(() => "idle" as const),
            timeoutPromise,
          ]);

          // Clean up the timeout timer to avoid leaks
          clearTimeout(timeoutHandle!);

          const idleDurationMs = Date.now() - idleStartMs;
          const timedOut = result === "timeout";
          console.log(
            tag,
            "IDLE returned after",
            idleDurationMs,
            "ms, timedOut:",
            timedOut,
            "pendingFetch:",
            pendingFetch,
          );
          this.logger.debug({ durationMs: idleDurationMs, timedOut }, "IDLE returned, re-entering");

          // Detect rapid IDLE returns (indicates broken connection)
          if (idleDurationMs < RAPID_RETURN_THRESHOLD_MS && !pendingFetch) {
            rapidReturnCount++;
            console.log(tag, "rapid IDLE return detected, count:", rapidReturnCount);
            if (rapidReturnCount >= MAX_RAPID_RETURNS) {
              console.log(tag, "too many rapid IDLE returns, forcing reconnect");
              this.logger.warn("IDLE spinning detected, forcing reconnect");
              throw new Error("IDLE spin loop detected, reconnecting");
            }
            // Add delay to prevent CPU spin
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            rapidReturnCount = 0; // Reset on normal IDLE duration
          }

          // Fetch new messages if:
          // 1. EXISTS event triggered (pendingFetch)
          // 2. Timeout reached (timedOut) - periodic poll as fallback
          if (pendingFetch || timedOut) {
            console.log(
              tag,
              "fetching new messages, reason:",
              pendingFetch ? "EXISTS" : "timeout-poll",
            );
            pendingFetch = false;
            await this.fetchNewMessages();

            // Check if EXISTS event fired during fetch (race condition)
            // If so, fetch again immediately to avoid missing new email
            while (pendingFetch && !this.shuttingDown && this.client?.usable) {
              console.log(tag, "EXISTS event during fetch detected, fetching again...");
              pendingFetch = false;
              await this.fetchNewMessages();
            }
          }
        } catch (err) {
          console.log(tag, "IDLE error:", err);
          if (this.shuttingDown) {
            break;
          }
          throw err;
        }
      }
    } finally {
      lock.release();
    }
  }

  private async fetchNewMessages(): Promise<void> {
    const tag = `[imap:${this.config.email}]`;
    console.log(tag, "fetchNewMessages() called");
    if (!this.client || this.shuttingDown) {
      console.log(
        tag,
        "fetchNewMessages() early return - client:",
        !!this.client,
        "shuttingDown:",
        this.shuttingDown,
      );
      return;
    }

    try {
      const currentMailbox = this.client.mailbox;
      console.log(tag, "current mailbox state:", {
        exists: currentMailbox ? (currentMailbox as { exists?: number }).exists : null,
        uidNext: currentMailbox ? (currentMailbox as { uidNext?: number }).uidNext : null,
        lastSeenUid: this.lastSeenUid,
      });

      const range = this.lastSeenUid > 0 ? `${this.lastSeenUid + 1}:*` : "*";
      console.log(tag, "fetching range:", range);

      let fetchCount = 0;
      for await (const msg of this.client.fetch(
        range,
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        fetchCount++;
        console.log(tag, "got message uid:", msg.uid, "seq:", msg.seq, "envelope:", !!msg.envelope);
        if (this.shuttingDown) {
          break;
        }

        if (msg.uid <= this.lastSeenUid) {
          console.log(tag, "skipping already seen uid:", msg.uid);
          continue;
        }

        this.lastSeenUid = Math.max(this.lastSeenUid, msg.uid);

        const email = await this.parseMessage(msg);
        if (email) {
          console.log(tag, "parsed email:", email.subject);
          this.logger.info(
            { uid: email.uid, from: email.from, subject: email.subject },
            "new email received",
          );
          this.emit("email", email);
          console.log(tag, "emitted email event");
        }
      }
      console.log(tag, "fetchNewMessages done, fetched:", fetchCount);
    } catch (err) {
      console.log(tag, "fetchNewMessages error:", err);
      this.logger.error({ err }, "failed to fetch new messages");
      this.emit("error", err as Error);
    }
  }

  private async parseMessage(msg: FetchMessageObject): Promise<ImapEmail | null> {
    console.log("[imap] parseMessage() uid:", msg.uid, "hasSource:", !!msg.source);
    try {
      if (!msg.source) {
        console.log("[imap] no source, using envelope");
        return {
          uid: msg.uid,
          messageId: msg.envelope?.messageId,
          date: msg.envelope?.date,
          from: this.extractEmailAddress(msg.envelope?.from?.[0]),
          fromName: msg.envelope?.from?.[0]?.name,
          to:
            (msg.envelope?.to
              ?.map((a: { address?: string }) => this.extractEmailAddress(a))
              .filter(Boolean) as string[]) ?? [],
          subject: msg.envelope?.subject,
          text: undefined,
          html: undefined,
          hasAttachments: false,
        };
      }

      console.log("[imap] parsing source...");
      const parsed = await simpleParser(msg.source);
      console.log("[imap] parsed, subject:", parsed.subject);

      return {
        uid: msg.uid,
        messageId: parsed.messageId,
        date: parsed.date,
        from: this.extractFromParsed(parsed.from),
        fromName: this.extractNameFromParsed(parsed.from),
        to: this.extractToAddresses(parsed.to),
        subject: parsed.subject,
        text: parsed.text,
        html: typeof parsed.html === "string" ? parsed.html : undefined,
        hasAttachments: (parsed.attachments?.length ?? 0) > 0,
      };
    } catch (err) {
      console.log("[imap] parseMessage error:", err);
      this.logger.warn({ err, uid: msg.uid }, "failed to parse message");
      return null;
    }
  }

  private extractEmailAddress(addr: { address?: string } | undefined): string | undefined {
    return addr?.address;
  }

  private extractFromParsed(from: AddressObject | AddressObject[] | undefined): string | undefined {
    if (!from) {
      return undefined;
    }
    const addr = Array.isArray(from) ? from[0] : from;
    return addr?.value?.[0]?.address;
  }

  private extractNameFromParsed(
    from: AddressObject | AddressObject[] | undefined,
  ): string | undefined {
    if (!from) {
      return undefined;
    }
    const addr = Array.isArray(from) ? from[0] : from;
    return addr?.value?.[0]?.name;
  }

  private extractToAddresses(to: AddressObject | AddressObject[] | undefined): string[] {
    if (!to) {
      return [];
    }
    const addrs = Array.isArray(to) ? to : [to];
    return addrs.flatMap(
      (a: { value?: Array<{ address?: string }> }) =>
        (a.value?.map((v: { address?: string }) => v.address).filter(Boolean) as string[]) ?? [],
    );
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    if (!this.options.autoReconnect) {
      return;
    }
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.logger.error("max reconnect attempts reached, giving up");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.options.reconnectDelayMs * Math.min(this.reconnectAttempts, 10);

    this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, "scheduling reconnect");
    this.emit("reconnecting", this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * Create and start an IMAP watcher.
 */
export async function createImapWatcher(
  config: ImapAccountRuntimeConfig,
  options?: ImapWatcherOptions,
): Promise<ImapWatcher> {
  const watcher = await ImapWatcher.fromConfig(config, options);
  await watcher.start();
  return watcher;
}

// Active watchers for gateway
const gatewayWatchers: Map<string, ImapWatcher> = new Map();

export type StartImapWatchersResult = {
  started: boolean;
  count: number;
  reason?: string;
};

export type ImapHookDispatcher = (params: {
  message: string;
  name: string;
  model?: string;
  thinking?: string;
  channel: string;
  deliver: boolean;
  /** Explicit delivery target (e.g., Feishu open_id like "ou_xxx"). */
  to?: string;
}) => void;

// Global hook dispatcher (set by gateway)
let imapHookDispatcher: ImapHookDispatcher | null = null;

/**
 * Set the hook dispatcher for IMAP emails.
 * Called by gateway during startup.
 */
export function setImapHookDispatcher(dispatcher: ImapHookDispatcher | null): void {
  imapHookDispatcher = dispatcher;
}

/**
 * Format email into a message for the agent.
 */
function formatEmailMessage(email: ImapEmail, accountEmail: string): string {
  const parts: string[] = [];
  parts.push(
    `[IMAP HOOK] 收到新邮件，请用中文转发给用户并提供简要摘要（无论邮件原文是什么语言，回复必须用中文）：`,
  );
  parts.push("");
  parts.push(`📧 新邮件 (${accountEmail}):`);
  parts.push("");
  if (email.from) {
    parts.push(`发件人: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}`);
  }
  if (email.to.length > 0) {
    parts.push(`收件人: ${email.to.join(", ")}`);
  }
  if (email.subject) {
    parts.push(`主题: ${email.subject}`);
  }
  if (email.date) {
    parts.push(`时间: ${email.date.toISOString()}`);
  }
  parts.push("");

  if (email.text) {
    // Truncate long emails
    const maxLen = 2000;
    const text =
      email.text.length > maxLen ? email.text.slice(0, maxLen) + "\n...(truncated)" : email.text;
    parts.push("内容:");
    parts.push(text);
  } else if (email.html) {
    parts.push("(HTML 邮件 - 纯文本内容不可用)");
  }

  return parts.join("\n");
}

/**
 * Save email to memory for future reference.
 */
async function saveEmailToMemory(
  email: ImapEmail,
  accountEmail: string,
  cfg: OpenClawConfig,
): Promise<void> {
  const logger = getChildLogger({ module: "imap-memory" });

  try {
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const memoryDir = path.join(workspaceDir, "memory", "emails");
    await fs.mkdir(memoryDir, { recursive: true });

    // Create filename with date
    const now = email.date ?? new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const filename = `${dateStr}.md`;
    const memoryFilePath = path.join(memoryDir, filename);

    // Format email as Markdown entry
    const timeStr = now.toISOString().split("T")[1]?.split(".")[0] ?? "00:00:00";
    const fromDisplay = email.fromName
      ? `${email.fromName} <${email.from}>`
      : (email.from ?? "unknown");
    const subjectDisplay = email.subject ?? "(no subject)";

    const entryParts = [
      "",
      `## ${timeStr} - ${subjectDisplay}`,
      "",
      `- **From**: ${fromDisplay}`,
      `- **To**: ${email.to.join(", ") || accountEmail}`,
      `- **Account**: ${accountEmail}`,
      `- **UID**: ${email.uid}`,
      `- **Message-ID**: ${email.messageId ?? "n/a"}`,
      "",
    ];

    if (email.text) {
      const maxLen = 1500;
      const text =
        email.text.length > maxLen ? email.text.slice(0, maxLen) + "\n...(truncated)" : email.text;
      entryParts.push("**Content:**", "", text, "");
    } else if (email.html) {
      entryParts.push("*(HTML email - see original)*", "");
    }

    entryParts.push("---", "");
    const entry = entryParts.join("\n");

    // Check if file exists to add header
    let existingContent = "";
    try {
      existingContent = await fs.readFile(memoryFilePath, "utf-8");
    } catch {
      // File doesn't exist, add header
      existingContent = `# Emails - ${dateStr}\n`;
    }

    // Append new email entry
    await fs.writeFile(memoryFilePath, existingContent + entry, "utf-8");
    logger.info({ path: memoryFilePath, subject: email.subject }, "email saved to memory");
  } catch (err) {
    logger.warn({ err, subject: email.subject }, "failed to save email to memory");
  }
}

/**
 * Start IMAP watchers for all configured accounts (called from gateway startup).
 */
export async function startImapWatchers(cfg: OpenClawConfig): Promise<StartImapWatchersResult> {
  console.log("[imap] startImapWatchers called");
  if (!cfg.hooks?.enabled) {
    console.log("[imap] hooks not enabled");
    return { started: false, count: 0, reason: "hooks not enabled" };
  }

  const accounts = cfg.hooks.imap?.accounts ?? [];
  console.log("[imap] accounts:", accounts.length);
  if (accounts.length === 0) {
    return { started: false, count: 0, reason: "no imap accounts configured" };
  }

  const logger = getChildLogger({ module: "imap-watcher" });
  console.log("[imap] got logger, calling logger.info...");
  logger.info({ accountCount: accounts.length }, "startImapWatchers starting");
  console.log("[imap] after logger.info");
  const defaults = {
    model: cfg.hooks.imap?.model,
    thinking: cfg.hooks.imap?.thinking,
  };

  let startedCount = 0;
  console.log("[imap] entering for loop, accounts:", accounts.length);

  for (const account of accounts) {
    console.log("[imap] processing:", account.email);
    logger.info({ email: account.email }, "processing account");
    const runtimeConfig: ImapAccountRuntimeConfig = {
      email: account.email.trim().toLowerCase(),
      host: account.host,
      port: account.port,
      secure: account.secure ?? true,
      mailbox: account.mailbox ?? "INBOX",
      model: account.model ?? defaults.model,
      thinking: account.thinking ?? defaults.thinking,
    };

    // Check credentials
    console.log("[imap] loading credentials for:", runtimeConfig.email);
    logger.info({ email: runtimeConfig.email }, "loading credentials...");
    const creds = await loadImapCredential(runtimeConfig.email);
    console.log("[imap] credentials loaded, has:", !!creds);
    logger.info({ email: runtimeConfig.email, hasCreds: !!creds }, "credentials loaded");
    if (!creds) {
      logger.warn({ email: runtimeConfig.email }, "no credentials, skipping");
      continue;
    }

    // Skip if already running
    console.log("[imap] checking if already running...");
    if (gatewayWatchers.has(runtimeConfig.email)) {
      console.log("[imap] already running, skipping");
      logger.debug({ email: runtimeConfig.email }, "already running, skipping");
      continue;
    }

    try {
      console.log("[imap] creating watcher...");
      logger.info({ email: runtimeConfig.email }, "creating watcher...");
      const watcher = new ImapWatcher(runtimeConfig, creds.password);
      console.log("[imap] watcher created, setting up events...");

      watcher.on("email", (email) => {
        console.log("[imap] EMAIL EVENT received:", email.subject);
        logger.info(
          { account: runtimeConfig.email, from: email.from, subject: email.subject },
          "new email received",
        );

        // Save email to memory for future reference (async, don't block)
        void saveEmailToMemory(email, runtimeConfig.email, cfg);

        // Dispatch to hook system
        console.log("[imap] imapHookDispatcher set?", !!imapHookDispatcher);
        if (imapHookDispatcher) {
          console.log("[imap] formatting and dispatching...");
          const message = formatEmailMessage(email, runtimeConfig.email);
          console.log("[imap] message length:", message.length);
          const deliverChannel = account.ownerChannel ?? "feishu";
          imapHookDispatcher({
            message,
            name: `IMAP: ${email.subject ?? "New Email"}`,
            model: runtimeConfig.model,
            thinking: runtimeConfig.thinking,
            channel: deliverChannel,
            deliver: true,
            to: account.ownerId,
          });
          console.log("[imap] dispatched!");
        } else {
          console.log("[imap] NO DISPATCHER - email will not be forwarded!");
        }
      });

      watcher.on("error", (err) => {
        logger.error({ account: runtimeConfig.email, err }, "watcher error");
      });

      watcher.on("connected", () => {
        logger.info({ account: runtimeConfig.email }, "connected");
      });

      watcher.on("disconnected", () => {
        logger.warn({ account: runtimeConfig.email }, "disconnected");
      });

      console.log("[imap] events set up, calling start()...");
      // Don't await - start() enters IDLE loop and never returns
      watcher.start().catch((err) => {
        console.log("[imap] start() error:", err);
        logger.error({ email: runtimeConfig.email, err }, "watcher start failed");
      });
      console.log("[imap] start() called, registering watcher...");
      gatewayWatchers.set(runtimeConfig.email, watcher);
      startedCount++;
      console.log("[imap] watcher registered, count:", startedCount);
    } catch (err) {
      logger.error({ email: runtimeConfig.email, err }, "failed to start watcher");
    }
  }

  return {
    started: startedCount > 0,
    count: startedCount,
    reason: startedCount === 0 ? "no watchers could be started" : undefined,
  };
}

/**
 * Stop all gateway IMAP watchers.
 */
export async function stopImapWatchers(): Promise<void> {
  const logger = getChildLogger({ module: "imap-watcher" });
  for (const [email, watcher] of gatewayWatchers) {
    await watcher.stop();
    logger.info({ email }, "stopped watcher");
  }
  gatewayWatchers.clear();
}

/**
 * Get count of active gateway IMAP watchers.
 */
export function getGatewayImapWatcherCount(): number {
  return gatewayWatchers.size;
}

/**
 * Dynamically start a single IMAP watcher (for runtime additions).
 * Returns true if started, false if already running or dispatcher not set.
 */
export async function startSingleImapWatcher(
  config: ImapAccountRuntimeConfig,
  password: string,
): Promise<{ started: boolean; reason?: string }> {
  const logger = getChildLogger({ module: "imap-watcher" });
  const email = config.email.trim().toLowerCase();

  if (!imapHookDispatcher) {
    return { started: false, reason: "hook dispatcher not initialized (gateway not running?)" };
  }

  if (gatewayWatchers.has(email)) {
    return { started: false, reason: "already running" };
  }

  try {
    const watcher = new ImapWatcher(config, password);

    watcher.on("email", (emailMsg) => {
      logger.info(
        { account: email, from: emailMsg.from, subject: emailMsg.subject },
        "new email received",
      );

      if (imapHookDispatcher) {
        const message = formatEmailMessage(emailMsg, email);
        imapHookDispatcher({
          message,
          name: `IMAP: ${emailMsg.subject ?? "New Email"}`,
          model: config.model,
          thinking: config.thinking,
          channel: "last",
          deliver: true,
        });
      }
    });

    watcher.on("error", (err) => {
      logger.error({ account: email, err }, "watcher error");
    });

    watcher.on("connected", () => {
      logger.info({ account: email }, "connected");
    });

    watcher.on("disconnected", () => {
      logger.warn({ account: email }, "disconnected");
    });

    await watcher.start();
    gatewayWatchers.set(email, watcher);
    logger.info({ email }, "dynamically started watcher");

    return { started: true };
  } catch (err) {
    logger.error({ email, err }, "failed to start watcher dynamically");
    return { started: false, reason: (err as Error).message };
  }
}

/**
 * Stop a single IMAP watcher (for runtime removals).
 */
export async function stopSingleImapWatcher(email: string): Promise<boolean> {
  const logger = getChildLogger({ module: "imap-watcher" });
  const normalized = email.trim().toLowerCase();
  const watcher = gatewayWatchers.get(normalized);

  if (!watcher) {
    return false;
  }

  await watcher.stop();
  gatewayWatchers.delete(normalized);
  logger.info({ email: normalized }, "dynamically stopped watcher");
  return true;
}

/**
 * Check if a watcher is currently running for an email.
 */
export function isImapWatcherRunning(email: string): boolean {
  return gatewayWatchers.has(email.trim().toLowerCase());
}
