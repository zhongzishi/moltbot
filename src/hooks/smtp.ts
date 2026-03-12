/**
 * SMTP email sending module.
 * Reuses IMAP credentials for sending emails via SMTP.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

import { getChildLogger } from "../logging.js";
import { loadImapCredential, listImapCredentials } from "./imap-credentials.js";

const logger = getChildLogger({ module: "smtp" });

/**
 * SMTP server presets for common email providers.
 * Maps domain to SMTP settings.
 */
export const SMTP_PRESETS: Record<
  string,
  {
    host: string;
    port: number;
    secure: boolean;
  }
> = {
  // Tencent Enterprise Mail (腾讯企业邮箱)
  "exmail.qq.com": {
    host: "smtp.exmail.qq.com",
    port: 465,
    secure: true,
  },

  // Tencent QQ Mail
  "qq.com": {
    host: "smtp.qq.com",
    port: 465,
    secure: true,
  },
  "foxmail.com": {
    host: "smtp.qq.com",
    port: 465,
    secure: true,
  },

  // Google
  "gmail.com": {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
  },
  "googlemail.com": {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
  },

  // Microsoft
  "outlook.com": {
    host: "smtp.office365.com",
    port: 587,
    secure: false, // STARTTLS
  },
  "hotmail.com": {
    host: "smtp.office365.com",
    port: 587,
    secure: false,
  },
  "live.com": {
    host: "smtp.office365.com",
    port: 587,
    secure: false,
  },

  // Yahoo
  "yahoo.com": {
    host: "smtp.mail.yahoo.com",
    port: 465,
    secure: true,
  },

  // iCloud
  "icloud.com": {
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
  },
  "me.com": {
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
  },

  // 163/126 (NetEase)
  "163.com": {
    host: "smtp.163.com",
    port: 465,
    secure: true,
  },
  "126.com": {
    host: "smtp.126.com",
    port: 465,
    secure: true,
  },

  // Zoho
  "zoho.com": {
    host: "smtp.zoho.com",
    port: 465,
    secure: true,
  },
};

/**
 * Get SMTP preset for an email address.
 */
export function getSmtpPreset(
  email: string,
): { host: string; port: number; secure: boolean } | null {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  // Check direct match
  if (SMTP_PRESETS[domain]) {
    return SMTP_PRESETS[domain];
  }

  // Check if it's a subdomain of a known provider
  for (const [knownDomain, preset] of Object.entries(SMTP_PRESETS)) {
    if (domain.endsWith(`.${knownDomain}`)) {
      return preset;
    }
  }

  // For enterprise domains, try to guess based on MX records pattern
  // e.g., xxx@company.com with exmail.qq.com MX -> use exmail settings
  // For now, return null and require explicit host
  return null;
}

/**
 * Detect SMTP settings for an email address.
 * First checks presets, then tries common patterns.
 */
export function detectSmtpSettings(
  email: string,
  explicitHost?: string,
): { host: string; port: number; secure: boolean } | null {
  if (explicitHost) {
    // If explicit host provided, use it with default SSL settings
    return {
      host: explicitHost,
      port: 465,
      secure: true,
    };
  }

  const preset = getSmtpPreset(email);
  if (preset) {
    return preset;
  }

  // Try common enterprise mail patterns
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  // Common pattern: smtp.<domain>
  return {
    host: `smtp.${domain}`,
    port: 465,
    secure: true,
  };
}

export type SendEmailOptions = {
  /** Sender email address (must have stored credentials) */
  from: string;
  /** Recipient email address(es) */
  to: string | string[];
  /** Email subject */
  subject: string;
  /** Email body (plain text) */
  text?: string;
  /** Email body (HTML) */
  html?: string;
  /** CC recipients */
  cc?: string | string[];
  /** BCC recipients */
  bcc?: string | string[];
  /** Reply-to address */
  replyTo?: string;
  /** Message-ID to reply to (for threading) */
  inReplyTo?: string;
  /** References header (for threading) */
  references?: string;
  /** Explicit SMTP host (overrides auto-detection) */
  smtpHost?: string;
  /** Explicit SMTP port */
  smtpPort?: number;
};

export type SendEmailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

/**
 * Create a nodemailer transporter for an email account.
 */
async function createTransporter(
  email: string,
  smtpHost?: string,
  smtpPort?: number,
): Promise<Transporter<SMTPTransport.SentMessageInfo> | null> {
  // Load credentials
  const credential = await loadImapCredential(email);
  if (!credential) {
    logger.warn({ email }, "No credentials found for email");
    return null;
  }

  // Detect SMTP settings
  const settings = detectSmtpSettings(email, smtpHost);
  if (!settings) {
    logger.warn({ email }, "Could not detect SMTP settings");
    return null;
  }

  const port = smtpPort ?? settings.port;
  const secure = smtpPort ? smtpPort === 465 : settings.secure;

  logger.debug({ email, host: settings.host, port, secure }, "Creating SMTP transporter");

  return nodemailer.createTransport({
    host: settings.host,
    port,
    secure,
    auth: {
      user: credential.email,
      pass: credential.password,
    },
  });
}

/**
 * Send an email using stored credentials.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { from, to, subject, text, html, cc, bcc, replyTo, inReplyTo, references, smtpHost, smtpPort } =
    options;

  logger.info({ from, to, subject }, "Sending email");

  try {
    const transporter = await createTransporter(from, smtpHost, smtpPort);
    if (!transporter) {
      return {
        success: false,
        error: `No credentials or SMTP settings found for ${from}. Use email_monitor to add credentials first.`,
      };
    }

    const mailOptions: nodemailer.SendMailOptions = {
      from,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      text,
      html,
    };

    if (cc) {
      mailOptions.cc = Array.isArray(cc) ? cc.join(", ") : cc;
    }
    if (bcc) {
      mailOptions.bcc = Array.isArray(bcc) ? bcc.join(", ") : bcc;
    }
    if (replyTo) {
      mailOptions.replyTo = replyTo;
    }
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
    }
    if (references) {
      mailOptions.references = references;
    }

    const result = await transporter.sendMail(mailOptions);
    logger.info({ messageId: result.messageId, from, to }, "Email sent successfully");

    return {
      success: true,
      messageId: result.messageId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage, from, to }, "Failed to send email");
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * List available sender accounts (emails with stored credentials).
 */
export async function listAvailableSenders(): Promise<string[]> {
  return listImapCredentials();
}
