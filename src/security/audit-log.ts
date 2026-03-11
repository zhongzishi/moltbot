/**
 * Security Audit Log - tracks configuration changes and sensitive operations.
 *
 * Logs are stored in ~/.clawdbot/audit.jsonl (append-only JSONL format).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getChildLogger } from "../logging.js";

const logger = getChildLogger({ module: "audit" });

export type AuditAction =
  | "config.update"
  | "config.delete"
  | "credential.add"
  | "credential.remove"
  | "hook.execute"
  | "hook.register"
  | "hook.remove"
  | "imap.connect"
  | "imap.disconnect"
  | "session.create"
  | "session.delete"
  | "gateway.start"
  | "gateway.stop"
  | "security.warning";

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  resource: string;
  details?: Record<string, unknown>;
  source?: string; // CLI, API, hook, etc.
  result: "success" | "failure" | "warning";
}

const AUDIT_DIR = path.join(os.homedir(), ".clawdbot");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.jsonl");
const MAX_AUDIT_SIZE = 10 * 1024 * 1024; // 10MB before rotation

/**
 * Ensure audit directory exists
 */
function ensureAuditDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Rotate audit log if it exceeds max size
 */
function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;

    const stats = fs.statSync(AUDIT_FILE);
    if (stats.size > MAX_AUDIT_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = path.join(AUDIT_DIR, `audit.${timestamp}.jsonl`);
      fs.renameSync(AUDIT_FILE, archivePath);
      logger.info(`Rotated audit log to ${archivePath}`);
    }
  } catch (err) {
    logger.warn(`Failed to rotate audit log: ${String(err)}`);
  }
}

/**
 * Write an entry to the audit log
 */
export function writeAuditLog(entry: Omit<AuditEntry, "timestamp">): void {
  try {
    ensureAuditDir();
    rotateIfNeeded();

    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    // Redact sensitive fields
    if (fullEntry.details) {
      fullEntry.details = redactSensitiveDetails(fullEntry.details);
    }

    const line = JSON.stringify(fullEntry) + "\n";
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch (err) {
    logger.warn(`Failed to write audit log: ${String(err)}`);
  }
}

/**
 * Redact sensitive values from audit details
 */
function redactSensitiveDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    "password",
    "secret",
    "token",
    "key",
    "credential",
    "apiKey",
    "accessToken",
    "refreshToken",
  ];

  const redacted = { ...details };

  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
      const value = redacted[key];
      if (typeof value === "string" && value.length > 0) {
        redacted[key] = value.length > 8 ? `${value.slice(0, 4)}...` : "***";
      }
    }
  }

  return redacted;
}

/**
 * Convenience functions for common audit events
 */
export const audit = {
  configUpdate: (resource: string, details?: Record<string, unknown>, source?: string) =>
    writeAuditLog({ action: "config.update", resource, details, source, result: "success" }),

  configDelete: (resource: string, source?: string) =>
    writeAuditLog({ action: "config.delete", resource, source, result: "success" }),

  credentialAdd: (resource: string, source?: string) =>
    writeAuditLog({ action: "credential.add", resource, source, result: "success" }),

  credentialRemove: (resource: string, source?: string) =>
    writeAuditLog({ action: "credential.remove", resource, source, result: "success" }),

  hookExecute: (resource: string, details?: Record<string, unknown>) =>
    writeAuditLog({ action: "hook.execute", resource, details, result: "success" }),

  hookRegister: (resource: string, details?: Record<string, unknown>) =>
    writeAuditLog({ action: "hook.register", resource, details, result: "success" }),

  imapConnect: (resource: string) =>
    writeAuditLog({ action: "imap.connect", resource, result: "success" }),

  imapDisconnect: (resource: string) =>
    writeAuditLog({ action: "imap.disconnect", resource, result: "success" }),

  securityWarning: (resource: string, details?: Record<string, unknown>) =>
    writeAuditLog({ action: "security.warning", resource, details, result: "warning" }),

  gatewayStart: (details?: Record<string, unknown>) =>
    writeAuditLog({ action: "gateway.start", resource: "gateway", details, result: "success" }),

  gatewayStop: () =>
    writeAuditLog({ action: "gateway.stop", resource: "gateway", result: "success" }),
};

/**
 * Read recent audit entries (for diagnostics)
 */
export function readRecentAuditEntries(limit = 100): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];

    const content = fs.readFileSync(AUDIT_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: AuditEntry[] = [];

    // Read from end (most recent)
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}
