/**
 * IMAP watcher using IDLE for real-time email notifications.
 */

import { EventEmitter } from "node:events";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";

import { getChildLogger } from "../logging.js";
import type { ImapAccountRuntimeConfig } from "./imap.js";
import { loadImapCredential } from "./imap-credentials.js";

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
};

const DEFAULT_OPTIONS: Required<ImapWatcherOptions> = {
  autoReconnect: true,
  reconnectDelayMs: 5000,
  maxReconnectAttempts: Infinity,
  idleTimeoutMs: 25 * 60 * 1000, // 25 minutes (IDLE has 29 min timeout on most servers)
};

export class ImapWatcher extends EventEmitter<ImapWatcherEvents> {
  private client: ImapFlow | null = null;
  private config: ImapAccountRuntimeConfig;
  private password: string;
  private options: Required<ImapWatcherOptions>;
  private logger: ReturnType<typeof getChildLogger>;
  private shuttingDown = false;
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

  private async connect(): Promise<void> {
    console.log("[imap] connect() called");
    if (this.shuttingDown) return;

    console.log("[imap] connecting to", this.config.host, this.config.port);
    this.logger.info({ host: this.config.host, port: this.config.port }, "connecting to IMAP");

    try {
      console.log("[imap] creating ImapFlow client...");
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
      console.log("[imap] ImapFlow client created");

      // Handle connection close
      this.client.on("close", () => {
        console.log("[imap] connection closed");
        if (!this.shuttingDown) {
          this.logger.warn("IMAP connection closed unexpectedly");
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });

      this.client.on("error", (err: Error) => {
        console.log("[imap] client error:", err.message);
        this.logger.error({ err }, "IMAP error");
        this.emit("error", err);
      });

      console.log("[imap] calling client.connect()...");
      await this.client.connect();
      console.log("[imap] client.connect() returned");
      this.reconnectAttempts = 0;
      this.emit("connected");
      console.log("[imap] emitted connected event");
      this.logger.info("connected to IMAP");

      // Start watching
      console.log("[imap] calling watchMailbox()...");
      await this.watchMailbox();
      console.log("[imap] watchMailbox() returned");
    } catch (err) {
      this.logger.error({ err }, "failed to connect to IMAP");
      this.emit("error", err as Error);
      this.scheduleReconnect();
    }
  }

  private async watchMailbox(): Promise<void> {
    console.log("[imap] watchMailbox() called");
    if (!this.client || this.shuttingDown) return;

    console.log("[imap] getting mailbox lock...");
    const lock = await this.client.getMailboxLock(this.config.mailbox);
    console.log("[imap] got mailbox lock");

    try {
      // Get initial message count
      const mailbox = this.client.mailbox;
      if (mailbox) {
        this.lastSeenUid = mailbox.uidNext ? mailbox.uidNext - 1 : 0;
        console.log("[imap] mailbox opened, lastUid:", this.lastSeenUid, "exists:", mailbox.exists);
        this.logger.info(
          { mailbox: this.config.mailbox, messageCount: mailbox.exists, lastUid: this.lastSeenUid },
          "mailbox opened",
        );
      }

      // Listen for new messages
      this.client.on("exists", async (data: { prevCount: number; count: number }) => {
        console.log("[imap] EXISTS event:", data);
        if (data.count > data.prevCount) {
          console.log("[imap] new message(s) detected!");
          this.logger.debug({ prevCount: data.prevCount, count: data.count }, "new message(s)");
          await this.fetchNewMessages();
        }
      });

      // Enter IDLE loop (maxIdleTime handles auto-restart)
      console.log("[imap] entering IDLE loop...");
      while (!this.shuttingDown && this.client?.usable) {
        try {
          // idle() returns when new data arrives or maxIdleTime expires
          console.log("[imap] calling client.idle()...");
          await this.client.idle();
          console.log("[imap] IDLE returned");
          this.logger.debug("IDLE returned, re-entering");
        } catch (err) {
          console.log("[imap] IDLE error:", err);
          if (this.shuttingDown) break;
          throw err;
        }
      }
    } finally {
      lock.release();
    }
  }

  private async fetchNewMessages(): Promise<void> {
    console.log("[imap] fetchNewMessages() called");
    if (!this.client || this.shuttingDown) return;

    try {
      // Fetch messages newer than last seen UID
      const range = this.lastSeenUid > 0 ? `${this.lastSeenUid + 1}:*` : "*";
      console.log("[imap] fetching range:", range);

      for await (const msg of this.client.fetch(range, {
        uid: true,
        envelope: true,
        source: true,
      })) {
        console.log("[imap] got message uid:", msg.uid);
        if (this.shuttingDown) break;

        // Skip if we've already seen this message
        if (msg.uid <= this.lastSeenUid) {
          console.log("[imap] skipping already seen uid:", msg.uid);
          continue;
        }

        this.lastSeenUid = Math.max(this.lastSeenUid, msg.uid);

        const email = await this.parseMessage(msg);
        if (email) {
          console.log("[imap] parsed email:", email.subject);
          this.logger.info(
            { uid: email.uid, from: email.from, subject: email.subject },
            "new email received",
          );
          this.emit("email", email);
          console.log("[imap] emitted email event");
        }
      }
      console.log("[imap] fetchNewMessages done");
    } catch (err) {
      console.log("[imap] fetchNewMessages error:", err);
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
              ?.map((a) => this.extractEmailAddress(a))
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
    if (!from) return undefined;
    const addr = Array.isArray(from) ? from[0] : from;
    return addr?.value?.[0]?.address;
  }

  private extractNameFromParsed(
    from: AddressObject | AddressObject[] | undefined,
  ): string | undefined {
    if (!from) return undefined;
    const addr = Array.isArray(from) ? from[0] : from;
    return addr?.value?.[0]?.name;
  }

  private extractToAddresses(to: AddressObject | AddressObject[] | undefined): string[] {
    if (!to) return [];
    const addrs = Array.isArray(to) ? to : [to];
    return addrs.flatMap((a) => (a.value?.map((v) => v.address).filter(Boolean) as string[]) ?? []);
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    if (!this.options.autoReconnect) return;
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
  parts.push(`[IMAP HOOK] 请将以下新邮件内容转发给用户（通过Feishu发送），并提供简要摘要：`);
  parts.push("");
  parts.push(`New email received on ${accountEmail}:`);
  parts.push("");
  if (email.from)
    parts.push(`From: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}`);
  if (email.to.length > 0) parts.push(`To: ${email.to.join(", ")}`);
  if (email.subject) parts.push(`Subject: ${email.subject}`);
  if (email.date) parts.push(`Date: ${email.date.toISOString()}`);
  parts.push("");

  if (email.text) {
    // Truncate long emails
    const maxLen = 2000;
    const text =
      email.text.length > maxLen ? email.text.slice(0, maxLen) + "\n...(truncated)" : email.text;
    parts.push("Content:");
    parts.push(text);
  } else if (email.html) {
    parts.push("(HTML email - text content not available)");
  }

  return parts.join("\n");
}

/**
 * Start IMAP watchers for all configured accounts (called from gateway startup).
 */
export async function startImapWatchers(cfg: {
  hooks?: {
    enabled?: boolean;
    imap?: {
      accounts?: Array<{
        email: string;
        host: string;
        port: number;
        secure?: boolean;
        mailbox?: string;
        model?: string;
        thinking?: "off" | "minimal" | "low" | "medium" | "high";
      }>;
      model?: string;
      thinking?: "off" | "minimal" | "low" | "medium" | "high";
    };
  };
}): Promise<StartImapWatchersResult> {
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

        // Dispatch to hook system
        console.log("[imap] imapHookDispatcher set?", !!imapHookDispatcher);
        if (imapHookDispatcher) {
          console.log("[imap] formatting and dispatching...");
          const message = formatEmailMessage(email, runtimeConfig.email);
          console.log("[imap] message length:", message.length);
          imapHookDispatcher({
            message,
            name: `IMAP: ${email.subject ?? "New Email"}`,
            model: runtimeConfig.model,
            thinking: runtimeConfig.thinking,
            channel: "feishu",
            deliver: true,
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
