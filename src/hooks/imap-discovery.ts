/**
 * IMAP server auto-discovery using Mozilla ISPDB and DNS SRV records.
 */

import { promises as dns } from "node:dns";
import { request } from "undici";
import { getEmailDomain, getImapPreset } from "./imap.js";

export type DiscoveredImapSettings = {
  host: string;
  port: number;
  secure: boolean;
  source: "preset" | "ispdb" | "srv" | "common" | "manual";
};

type IspdbServer = {
  hostname: string;
  port: number;
  socketType: "SSL" | "STARTTLS" | "plain";
};

/**
 * Discover IMAP settings for an email address.
 * Tries multiple methods in order:
 * 1. Known presets (163, QQ, etc.)
 * 2. Mozilla ISPDB
 * 3. DNS SRV records
 * 4. Common hostname patterns
 */
export async function discoverImapSettings(
  email: string,
  timeoutMs = 5000,
): Promise<DiscoveredImapSettings | null> {
  const domain = getEmailDomain(email);
  if (!domain) return null;

  // 1. Check presets first
  const preset = getImapPreset(email);
  if (preset) {
    return {
      host: preset.host,
      port: preset.port,
      secure: preset.secure,
      source: "preset",
    };
  }

  // 2. Try Mozilla ISPDB
  const ispdb = await tryMozillaIspdb(domain, timeoutMs);
  if (ispdb) {
    return {
      host: ispdb.hostname,
      port: ispdb.port,
      secure: ispdb.socketType === "SSL",
      source: "ispdb",
    };
  }

  // 3. Try DNS SRV records
  const srv = await trySrvRecords(domain);
  if (srv) {
    return {
      host: srv.host,
      port: srv.port,
      secure: srv.port === 993,
      source: "srv",
    };
  }

  // 4. Try common hostname patterns
  const common = await tryCommonHostnames(domain, timeoutMs);
  if (common) {
    return {
      host: common.host,
      port: common.port,
      secure: common.secure,
      source: "common",
    };
  }

  return null;
}

/**
 * Query Mozilla ISPDB for IMAP configuration.
 * https://autoconfig.thunderbird.net/v1.1/
 */
async function tryMozillaIspdb(domain: string, timeoutMs: number): Promise<IspdbServer | null> {
  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ];

  for (const url of urls) {
    try {
      const response = await request(url, {
        method: "GET",
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (response.statusCode !== 200) continue;

      const text = await response.body.text();
      const server = parseIspdbXml(text);
      if (server) return server;
    } catch {
      // Continue to next URL
    }
  }

  return null;
}

/**
 * Parse ISPDB XML response for IMAP server config.
 */
function parseIspdbXml(xml: string): IspdbServer | null {
  // Simple regex parsing (avoid XML parser dependency)
  const incomingMatch = xml.match(
    /<incomingServer\s+type="imap"[^>]*>([\s\S]*?)<\/incomingServer>/i,
  );
  if (!incomingMatch) return null;

  const block = incomingMatch[1] ?? "";

  const hostnameMatch = block.match(/<hostname>([^<]+)<\/hostname>/i);
  const portMatch = block.match(/<port>(\d+)<\/port>/i);
  const socketMatch = block.match(/<socketType>(SSL|STARTTLS|plain)<\/socketType>/i);

  if (!hostnameMatch || !portMatch) return null;

  return {
    hostname: hostnameMatch[1]?.trim() ?? "",
    port: parseInt(portMatch[1] ?? "993", 10),
    socketType: (socketMatch?.[1] as "SSL" | "STARTTLS" | "plain") ?? "SSL",
  };
}

/**
 * Try DNS SRV records for IMAP.
 * RFC 6186: _imaps._tcp for implicit TLS, _imap._tcp for STARTTLS
 */
async function trySrvRecords(domain: string): Promise<{ host: string; port: number } | null> {
  const srvNames = [`_imaps._tcp.${domain}`, `_imap._tcp.${domain}`];

  for (const name of srvNames) {
    try {
      const records = await dns.resolveSrv(name);
      if (records.length > 0) {
        // Sort by priority (lower is better), then weight (higher is better)
        records.sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return b.weight - a.weight;
        });
        const best = records[0];
        if (best) {
          return { host: best.name, port: best.port };
        }
      }
    } catch {
      // SRV record not found, continue
    }
  }

  return null;
}

/**
 * Try common IMAP hostname patterns.
 */
async function tryCommonHostnames(
  domain: string,
  timeoutMs: number,
): Promise<{ host: string; port: number; secure: boolean } | null> {
  const patterns = [
    { host: `imap.${domain}`, port: 993, secure: true },
    { host: `mail.${domain}`, port: 993, secure: true },
    { host: `mx.${domain}`, port: 993, secure: true },
    { host: domain, port: 993, secure: true },
  ];

  for (const pattern of patterns) {
    try {
      // Check if hostname resolves
      await dns.resolve4(pattern.host);

      // Try to connect (basic port check)
      const canConnect = await checkPort(pattern.host, pattern.port, timeoutMs);
      if (canConnect) {
        return pattern;
      }
    } catch {
      // Continue to next pattern
    }
  }

  return null;
}

/**
 * Check if a port is open (basic TCP connection test).
 */
async function checkPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { connect } = await import("node:net");

  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Get human-readable help text for setting up IMAP access.
 */
export function getImapSetupHelp(email: string): {
  authType: string;
  helpUrl?: string;
  helpText?: string;
} {
  const preset = getImapPreset(email);

  if (preset) {
    return {
      authType:
        preset.authType === "app-password" ? "App Password / Authorization Code" : "Password",
      helpUrl: preset.helpUrl,
      helpText: preset.helpText,
    };
  }

  return {
    authType: "Password or App Password",
    helpText: "Check your email provider's IMAP settings documentation",
  };
}
