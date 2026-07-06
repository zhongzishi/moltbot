/**
 * IMAP watcher configuration types and provider presets.
 */

// Auth types for different email providers
export type ImapAuthType = "password" | "app-password" | "oauth2";

// Provider preset configuration
export type ImapPreset = {
  host: string;
  port: number;
  secure: boolean;
  authType: ImapAuthType;
  helpUrl?: string;
  helpText?: string;
};

// Single IMAP account configuration (stored in config.yaml)
export type ImapAccountConfig = {
  email: string;
  host: string;
  port: number;
  secure?: boolean;
  mailbox?: string; // default: INBOX
  /** Optional model override for IMAP hook processing. */
  model?: string;
  /** Optional thinking level override for IMAP hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** Owner identifier (e.g., Feishu open_id) for delivery target and credential encryption. */
  ownerId?: string;
  /** Owner's channel for delivery (e.g., "feishu"). */
  ownerChannel?: string;
};

// Full IMAP hooks config (in hooks.imap)
export type HooksImapConfig = {
  accounts?: ImapAccountConfig[];
  /** Default model for all IMAP accounts. */
  model?: string;
  /** Default thinking level for all IMAP accounts. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

// Runtime config for a single IMAP account
export type ImapAccountRuntimeConfig = {
  email: string;
  host: string;
  port: number;
  secure: boolean;
  mailbox: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};

// Default values
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_IMAP_MAILBOX = "INBOX";
export const DEFAULT_IMAP_SECURE = true;

// IMAP provider presets
export const IMAP_PRESETS: Record<string, ImapPreset> = {
  // Chinese providers
  "163.com": {
    host: "imap.163.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac21b87735d7227c217",
    helpText: "登录 mail.163.com -> 设置 -> POP3/SMTP/IMAP -> 开启 IMAP 服务 -> 生成授权码",
  },
  "126.com": {
    host: "imap.126.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl:
      "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac21b87735d7227c217",
    helpText: "登录 mail.126.com -> 设置 -> POP3/SMTP/IMAP -> 开启 IMAP 服务 -> 生成授权码",
  },
  "qq.com": {
    host: "imap.qq.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://service.mail.qq.com/detail/0/310",
    helpText: "登录 mail.qq.com -> 设置 -> 账户 -> POP3/IMAP/SMTP -> 开启 IMAP -> 生成授权码",
  },
  "foxmail.com": {
    host: "imap.qq.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://service.mail.qq.com/detail/0/310",
    helpText: "登录 mail.qq.com -> 设置 -> 账户 -> POP3/IMAP/SMTP -> 开启 IMAP -> 生成授权码",
  },

  // International providers
  "outlook.com": {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    authType: "password",
    helpUrl:
      "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
    helpText: "Use your regular password or app password if 2FA is enabled",
  },
  "hotmail.com": {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    authType: "password",
    helpUrl:
      "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
  },
  "live.com": {
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    authType: "password",
  },
  "yahoo.com": {
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://help.yahoo.com/kb/generate-app-password-sln15241.html",
    helpText: "Go to Yahoo Account Security -> Generate app password",
  },
  "icloud.com": {
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://support.apple.com/en-us/102654",
    helpText:
      "Go to appleid.apple.com -> Sign-In and Security -> App-Specific Passwords -> Generate",
  },
  "me.com": {
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://support.apple.com/en-us/102654",
  },
  "mac.com": {
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://support.apple.com/en-us/102654",
  },
  "gmail.com": {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://support.google.com/accounts/answer/185833",
    helpText: "Enable 2FA, then go to Google Account -> Security -> App passwords -> Generate",
  },
  "googlemail.com": {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://support.google.com/accounts/answer/185833",
  },

  // Other providers
  "protonmail.com": {
    host: "127.0.0.1", // ProtonMail Bridge required
    port: 1143,
    secure: false,
    authType: "password",
    helpUrl: "https://proton.me/support/protonmail-bridge-clients-apple-mail",
    helpText:
      "ProtonMail requires Bridge app. Install Bridge, then use Bridge-generated credentials.",
  },
  "proton.me": {
    host: "127.0.0.1",
    port: 1143,
    secure: false,
    authType: "password",
    helpUrl: "https://proton.me/support/protonmail-bridge-clients-apple-mail",
    helpText:
      "ProtonMail requires Bridge app. Install Bridge, then use Bridge-generated credentials.",
  },
  "zoho.com": {
    host: "imap.zoho.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://www.zoho.com/mail/help/imap-access.html",
  },
  "aol.com": {
    host: "imap.aol.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://help.aol.com/articles/allow-apps-that-use-less-secure-sign-in",
  },
  "gmx.com": {
    host: "imap.gmx.com",
    port: 993,
    secure: true,
    authType: "password",
    helpUrl: "https://www.gmx.com/mail/imap/",
    helpText: "Enable IMAP in GMX settings -> POP3 & IMAP",
  },
  "gmx.net": {
    host: "imap.gmx.net",
    port: 993,
    secure: true,
    authType: "password",
  },
  "mail.com": {
    host: "imap.mail.com",
    port: 993,
    secure: true,
    authType: "password",
  },
  "yandex.com": {
    host: "imap.yandex.com",
    port: 993,
    secure: true,
    authType: "app-password",
    helpUrl: "https://yandex.com/support/mail/mail-clients.html",
  },
  "yandex.ru": {
    host: "imap.yandex.ru",
    port: 993,
    secure: true,
    authType: "app-password",
  },
};

/**
 * Get email domain from address.
 */
export function getEmailDomain(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  return parts[1] ?? "";
}

/**
 * Get IMAP preset for an email address.
 */
export function getImapPreset(email: string): ImapPreset | undefined {
  const domain = getEmailDomain(email);
  return IMAP_PRESETS[domain];
}

/**
 * Check if an email domain has a known preset.
 */
export function hasImapPreset(email: string): boolean {
  return getImapPreset(email) !== undefined;
}

/**
 * Resolve IMAP account config with defaults.
 */
export function resolveImapAccountConfig(
  account: ImapAccountConfig,
  defaults?: { model?: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" },
): ImapAccountRuntimeConfig {
  const preset = getImapPreset(account.email);

  return {
    email: account.email.trim().toLowerCase(),
    host: account.host || preset?.host || "",
    port: account.port || preset?.port || DEFAULT_IMAP_PORT,
    secure: account.secure ?? preset?.secure ?? DEFAULT_IMAP_SECURE,
    mailbox: account.mailbox || DEFAULT_IMAP_MAILBOX,
    model: account.model ?? defaults?.model,
    thinking: account.thinking ?? defaults?.thinking,
  };
}

/**
 * Validate IMAP account config.
 */
export function validateImapAccountConfig(
  account: ImapAccountConfig,
): { ok: true } | { ok: false; error: string } {
  if (!account.email || !account.email.includes("@")) {
    return { ok: false, error: "Invalid email address" };
  }
  if (!account.host) {
    const preset = getImapPreset(account.email);
    if (!preset) {
      return {
        ok: false,
        error: `Unknown email provider. Please specify IMAP host for ${getEmailDomain(account.email)}`,
      };
    }
  }
  if (account.port && (account.port < 1 || account.port > 65535)) {
    return { ok: false, error: "Invalid port number" };
  }
  return { ok: true };
}
