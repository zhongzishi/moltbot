/**
 * IMAP credentials storage.
 * Credentials are stored in ~/.clawdbot/credentials/imap/<email>.json
 * Encryption key is derived from the owner's ID (e.g., Feishu open_id).
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { resolveOAuthDir } from "../config/paths.js";

const IMAP_CREDS_SUBDIR = "imap";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export type ImapCredential = {
  email: string;
  password: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

type EncryptedData = {
  salt: string; // hex
  iv: string; // hex
  authTag: string; // hex
  data: string; // hex (encrypted)
};

type CredentialFile = {
  version: 2;
  ownerId: string;
  encrypted: EncryptedData;
};

/**
 * Get the credentials directory for IMAP.
 */
export function getImapCredsDir(): string {
  return path.join(resolveOAuthDir(), IMAP_CREDS_SUBDIR);
}

/**
 * Get the credential file path for an email.
 */
export function getImapCredPath(email: string): string {
  // Sanitize email for filename
  const safeEmail = email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_");
  return path.join(getImapCredsDir(), `${safeEmail}.json`);
}

/**
 * Derive encryption key from owner ID.
 */
function deriveKey(salt: Buffer, ownerId: string): Buffer {
  const keyMaterial = `${ownerId}:imap-creds`;
  return scryptSync(keyMaterial, salt, 32);
}

/**
 * Encrypt credential data using owner ID as key basis.
 */
function encrypt(plaintext: string, ownerId: string): EncryptedData {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt, ownerId);

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

/**
 * Decrypt credential data using owner ID as key basis.
 */
function decrypt(encrypted: EncryptedData, ownerId: string): string {
  const salt = Buffer.from(encrypted.salt, "hex");
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const data = Buffer.from(encrypted.data, "hex");
  const key = deriveKey(salt, ownerId);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Save IMAP credentials for an email account.
 * @param email - The email address
 * @param password - The password or app password
 * @param ownerId - Owner identifier (e.g., Feishu open_id) used for encryption
 */
export async function saveImapCredential(
  email: string,
  password: string,
  ownerId: string,
): Promise<void> {
  const credsDir = getImapCredsDir();
  await fs.mkdir(credsDir, { recursive: true, mode: 0o700 });

  const credPath = getImapCredPath(email);
  const now = new Date().toISOString();

  // Check if exists for updatedAt
  let createdAt = now;
  try {
    const existing = await loadImapCredential(email);
    if (existing) {
      createdAt = existing.createdAt;
    }
  } catch {
    // New credential
  }

  const credential: ImapCredential = {
    email: email.trim().toLowerCase(),
    password,
    ownerId,
    createdAt,
    updatedAt: now,
  };

  const encrypted = encrypt(JSON.stringify(credential), ownerId);
  const fileContent: CredentialFile = {
    version: 2,
    ownerId,
    encrypted,
  };

  await fs.writeFile(credPath, JSON.stringify(fileContent, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Load IMAP credentials for an email account.
 * The ownerId is read from the file and used to derive the decryption key.
 */
export async function loadImapCredential(email: string): Promise<ImapCredential | null> {
  const credPath = getImapCredPath(email);

  try {
    const raw = await fs.readFile(credPath, "utf-8");
    const file = JSON.parse(raw) as CredentialFile;

    if (file.version !== 2) {
      throw new Error(
        `Unsupported credential version: ${String((file as { version?: unknown }).version)}`,
      );
    }

    const decrypted = decrypt(file.encrypted, file.ownerId);
    return JSON.parse(decrypted) as ImapCredential;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Check if credentials exist for an email (sync).
 */
export function hasImapCredentialSync(email: string): boolean {
  const credPath = getImapCredPath(email);
  try {
    const stats = fsSync.statSync(credPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Delete IMAP credentials for an email account.
 */
export async function deleteImapCredential(email: string): Promise<boolean> {
  const credPath = getImapCredPath(email);

  try {
    await fs.unlink(credPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * List all stored IMAP credentials (emails only).
 */
export async function listImapCredentials(): Promise<string[]> {
  const credsDir = getImapCredsDir();

  try {
    const files = await fs.readdir(credsDir);
    const emails: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const credPath = path.join(credsDir, file);
        const raw = await fs.readFile(credPath, "utf-8");
        const fileContent = JSON.parse(raw) as CredentialFile;
        if (fileContent.version !== 2) continue;
        const decrypted = decrypt(fileContent.encrypted, fileContent.ownerId);
        const credential = JSON.parse(decrypted) as ImapCredential;
        emails.push(credential.email);
      } catch {
        // Skip invalid files
      }
    }

    return emails;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
