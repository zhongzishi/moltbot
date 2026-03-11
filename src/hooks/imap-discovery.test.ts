import { describe, expect, it } from "vitest";

import { discoverImapSettings, getImapSetupHelp } from "./imap-discovery.js";

describe("imap-discovery", () => {
  describe("discoverImapSettings", () => {
    it("returns preset for known providers", async () => {
      const result = await discoverImapSettings("user@163.com");

      expect(result).not.toBeNull();
      expect(result?.host).toBe("imap.163.com");
      expect(result?.port).toBe(993);
      expect(result?.secure).toBe(true);
      expect(result?.source).toBe("preset");
    });

    it("returns preset for QQ mail", async () => {
      const result = await discoverImapSettings("user@qq.com");

      expect(result).not.toBeNull();
      expect(result?.host).toBe("imap.qq.com");
      expect(result?.source).toBe("preset");
    });

    it("returns preset for Gmail", async () => {
      const result = await discoverImapSettings("user@gmail.com");

      expect(result).not.toBeNull();
      expect(result?.host).toBe("imap.gmail.com");
      expect(result?.source).toBe("preset");
    });

    it("returns null for invalid email", async () => {
      const result = await discoverImapSettings("invalid");
      expect(result).toBeNull();
    });

    it("is case-insensitive", async () => {
      const result = await discoverImapSettings("USER@163.COM");

      expect(result).not.toBeNull();
      expect(result?.host).toBe("imap.163.com");
    });
  });

  describe("getImapSetupHelp", () => {
    it("returns app-password help for 163", () => {
      const help = getImapSetupHelp("user@163.com");

      expect(help.authType).toContain("App Password");
      expect(help.helpUrl).toBeDefined();
      expect(help.helpText).toBeDefined();
    });

    it("returns app-password help for QQ", () => {
      const help = getImapSetupHelp("user@qq.com");

      expect(help.authType).toContain("App Password");
      expect(help.helpUrl).toBeDefined();
    });

    it("returns password help for Outlook", () => {
      const help = getImapSetupHelp("user@outlook.com");

      expect(help.authType).toBe("Password");
    });

    it("returns generic help for unknown provider", () => {
      const help = getImapSetupHelp("user@unknown.com");

      expect(help.authType).toContain("Password");
      expect(help.helpText).toBeDefined();
    });
  });
});
