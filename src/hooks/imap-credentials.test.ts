import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteImapCredential,
  getImapCredPath,
  getImapCredsDir,
  hasImapCredentialSync,
  listImapCredentials,
  loadImapCredential,
  saveImapCredential,
} from "./imap-credentials.js";

// Mock the credentials directory to use a temp directory
vi.mock("../config/paths.js", () => ({
  resolveOAuthDir: () => {
    const tmpDir = process.env.TEST_IMAP_CREDS_DIR;
    if (!tmpDir) throw new Error("TEST_IMAP_CREDS_DIR not set");
    return tmpDir;
  },
}));

describe("imap-credentials", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "imap-creds-test-"));
    process.env.TEST_IMAP_CREDS_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.TEST_IMAP_CREDS_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getImapCredsDir", () => {
    it("returns path under credentials directory", () => {
      const dir = getImapCredsDir();
      expect(dir).toContain("imap");
    });
  });

  describe("getImapCredPath", () => {
    it("returns path for email", () => {
      const credPath = getImapCredPath("user@example.com");
      expect(credPath).toContain("user@example.com.json");
    });

    it("sanitizes special characters", () => {
      const credPath = getImapCredPath("user+tag@example.com");
      expect(credPath).not.toContain("+");
    });

    it("normalizes to lowercase", () => {
      const credPath = getImapCredPath("USER@EXAMPLE.COM");
      expect(credPath).toContain("user@example.com");
    });
  });

  describe("saveImapCredential / loadImapCredential", () => {
    const testOwnerId = "test-owner-123";

    it("saves and loads credentials", async () => {
      const email = "test@example.com";
      const password = "secret123";

      await saveImapCredential(email, password, testOwnerId);
      const loaded = await loadImapCredential(email);

      expect(loaded).not.toBeNull();
      expect(loaded?.email).toBe(email);
      expect(loaded?.password).toBe(password);
      expect(loaded?.ownerId).toBe(testOwnerId);
      expect(loaded?.createdAt).toBeDefined();
      expect(loaded?.updatedAt).toBeDefined();
    });

    it("updates existing credential", async () => {
      const email = "test@example.com";

      await saveImapCredential(email, "password1", testOwnerId);
      const first = await loadImapCredential(email);

      await saveImapCredential(email, "password2", testOwnerId);
      const second = await loadImapCredential(email);

      expect(second?.password).toBe("password2");
      expect(second?.createdAt).toBe(first?.createdAt);
      expect(second?.updatedAt).not.toBe(first?.updatedAt);
    });

    it("returns null for non-existent credential", async () => {
      const loaded = await loadImapCredential("nonexistent@example.com");
      expect(loaded).toBeNull();
    });

    it("encrypts password on disk", async () => {
      const email = "test@example.com";
      const password = "secret123";

      await saveImapCredential(email, password, testOwnerId);

      const credPath = getImapCredPath(email);
      const raw = await fs.readFile(credPath, "utf-8");
      const data = JSON.parse(raw);

      // Should not contain plaintext password
      expect(raw).not.toContain(password);
      // Should have encryption fields (version 2 format)
      expect(data.version).toBe(2);
      expect(data.ownerId).toBe(testOwnerId);
      expect(data.encrypted.salt).toBeDefined();
      expect(data.encrypted.iv).toBeDefined();
      expect(data.encrypted.authTag).toBeDefined();
      expect(data.encrypted.data).toBeDefined();
    });
  });

  describe("hasImapCredentialSync", () => {
    it("returns true when credential exists", async () => {
      const email = "test@example.com";
      await saveImapCredential(email, "password", "owner-1");

      expect(hasImapCredentialSync(email)).toBe(true);
    });

    it("returns false when credential does not exist", () => {
      expect(hasImapCredentialSync("nonexistent@example.com")).toBe(false);
    });
  });

  describe("deleteImapCredential", () => {
    it("deletes existing credential", async () => {
      const email = "test@example.com";
      await saveImapCredential(email, "password", "owner-1");

      const deleted = await deleteImapCredential(email);

      expect(deleted).toBe(true);
      expect(await loadImapCredential(email)).toBeNull();
    });

    it("returns false for non-existent credential", async () => {
      const deleted = await deleteImapCredential("nonexistent@example.com");
      expect(deleted).toBe(false);
    });
  });

  describe("listImapCredentials", () => {
    it("lists all saved credentials", async () => {
      await saveImapCredential("user1@example.com", "pass1", "owner-1");
      await saveImapCredential("user2@example.com", "pass2", "owner-2");

      const emails = await listImapCredentials();

      expect(emails).toHaveLength(2);
      expect(emails).toContain("user1@example.com");
      expect(emails).toContain("user2@example.com");
    });

    it("returns empty array when no credentials", async () => {
      const emails = await listImapCredentials();
      expect(emails).toEqual([]);
    });
  });
});
