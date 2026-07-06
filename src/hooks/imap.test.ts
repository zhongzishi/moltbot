import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAP_MAILBOX,
  DEFAULT_IMAP_PORT,
  DEFAULT_IMAP_SECURE,
  getEmailDomain,
  getImapPreset,
  hasImapPreset,
  IMAP_PRESETS,
  resolveImapAccountConfig,
  validateImapAccountConfig,
} from "./imap.js";

describe("imap", () => {
  describe("getEmailDomain", () => {
    it("extracts domain from email", () => {
      expect(getEmailDomain("user@example.com")).toBe("example.com");
      expect(getEmailDomain("USER@EXAMPLE.COM")).toBe("example.com");
      expect(getEmailDomain("  user@example.com  ")).toBe("example.com");
    });

    it("returns empty string for invalid email", () => {
      expect(getEmailDomain("invalid")).toBe("");
      expect(getEmailDomain("")).toBe("");
    });
  });

  describe("getImapPreset", () => {
    it("returns preset for known providers", () => {
      const preset163 = getImapPreset("user@163.com");
      expect(preset163).toBeDefined();
      expect(preset163?.host).toBe("imap.163.com");
      expect(preset163?.port).toBe(993);
      expect(preset163?.secure).toBe(true);

      const presetQQ = getImapPreset("user@qq.com");
      expect(presetQQ).toBeDefined();
      expect(presetQQ?.host).toBe("imap.qq.com");

      const presetGmail = getImapPreset("user@gmail.com");
      expect(presetGmail).toBeDefined();
      expect(presetGmail?.host).toBe("imap.gmail.com");
    });

    it("returns undefined for unknown providers", () => {
      expect(getImapPreset("user@unknown-domain.com")).toBeUndefined();
    });

    it("is case-insensitive", () => {
      expect(getImapPreset("USER@163.COM")).toBeDefined();
      expect(getImapPreset("User@QQ.Com")).toBeDefined();
    });
  });

  describe("hasImapPreset", () => {
    it("returns true for known providers", () => {
      expect(hasImapPreset("user@163.com")).toBe(true);
      expect(hasImapPreset("user@qq.com")).toBe(true);
      expect(hasImapPreset("user@outlook.com")).toBe(true);
    });

    it("returns false for unknown providers", () => {
      expect(hasImapPreset("user@custom.com")).toBe(false);
    });
  });

  describe("IMAP_PRESETS", () => {
    it("has presets for major Chinese providers", () => {
      expect(IMAP_PRESETS["163.com"]).toBeDefined();
      expect(IMAP_PRESETS["126.com"]).toBeDefined();
      expect(IMAP_PRESETS["qq.com"]).toBeDefined();
      expect(IMAP_PRESETS["foxmail.com"]).toBeDefined();
    });

    it("has presets for major international providers", () => {
      expect(IMAP_PRESETS["gmail.com"]).toBeDefined();
      expect(IMAP_PRESETS["outlook.com"]).toBeDefined();
      expect(IMAP_PRESETS["yahoo.com"]).toBeDefined();
      expect(IMAP_PRESETS["icloud.com"]).toBeDefined();
    });

    it("all presets have required fields", () => {
      for (const [domain, preset] of Object.entries(IMAP_PRESETS)) {
        expect(preset.host, `${domain} missing host`).toBeTruthy();
        expect(preset.port, `${domain} missing port`).toBeGreaterThan(0);
        expect(typeof preset.secure, `${domain} secure should be boolean`).toBe("boolean");
        expect(preset.authType, `${domain} missing authType`).toBeTruthy();
      }
    });
  });

  describe("resolveImapAccountConfig", () => {
    it("uses preset values when host not specified", () => {
      const config = resolveImapAccountConfig({
        email: "user@163.com",
        host: "",
        port: 0,
      });

      expect(config.email).toBe("user@163.com");
      expect(config.host).toBe("imap.163.com");
      expect(config.port).toBe(993);
      expect(config.secure).toBe(true);
      expect(config.mailbox).toBe(DEFAULT_IMAP_MAILBOX);
    });

    it("uses provided values over preset", () => {
      const config = resolveImapAccountConfig({
        email: "user@163.com",
        host: "custom.host.com",
        port: 143,
        secure: false,
        mailbox: "Archive",
      });

      expect(config.host).toBe("custom.host.com");
      expect(config.port).toBe(143);
      expect(config.secure).toBe(false);
      expect(config.mailbox).toBe("Archive");
    });

    it("uses defaults for unknown providers", () => {
      const config = resolveImapAccountConfig({
        email: "user@custom.com",
        host: "imap.custom.com",
        port: 0,
      });

      expect(config.port).toBe(DEFAULT_IMAP_PORT);
      expect(config.secure).toBe(DEFAULT_IMAP_SECURE);
    });

    it("normalizes email to lowercase", () => {
      const config = resolveImapAccountConfig({
        email: "  USER@EXAMPLE.COM  ",
        host: "imap.example.com",
        port: 993,
      });

      expect(config.email).toBe("user@example.com");
    });

    it("applies default model and thinking from parent config", () => {
      const config = resolveImapAccountConfig(
        {
          email: "user@163.com",
          host: "imap.163.com",
          port: 993,
        },
        { model: "anthropic/claude-3", thinking: "low" },
      );

      expect(config.model).toBe("anthropic/claude-3");
      expect(config.thinking).toBe("low");
    });

    it("account-level model overrides default", () => {
      const config = resolveImapAccountConfig(
        {
          email: "user@163.com",
          host: "imap.163.com",
          port: 993,
          model: "openai/gpt-4",
        },
        { model: "anthropic/claude-3" },
      );

      expect(config.model).toBe("openai/gpt-4");
    });
  });

  describe("validateImapAccountConfig", () => {
    it("accepts valid config with known provider", () => {
      const result = validateImapAccountConfig({
        email: "user@163.com",
        host: "",
        port: 0,
      });

      expect(result.ok).toBe(true);
    });

    it("accepts valid config with explicit host", () => {
      const result = validateImapAccountConfig({
        email: "user@custom.com",
        host: "imap.custom.com",
        port: 993,
      });

      expect(result.ok).toBe(true);
    });

    it("rejects invalid email", () => {
      const result = validateImapAccountConfig({
        email: "invalid",
        host: "imap.example.com",
        port: 993,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid email");
      }
    });

    it("rejects unknown provider without host", () => {
      const result = validateImapAccountConfig({
        email: "user@unknown-provider.com",
        host: "",
        port: 993,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Unknown email provider");
      }
    });

    it("rejects invalid port", () => {
      const result = validateImapAccountConfig({
        email: "user@163.com",
        host: "imap.163.com",
        port: 99999,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid port");
      }
    });
  });
});
