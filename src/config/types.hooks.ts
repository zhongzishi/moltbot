import type { z } from "zod";
import type {
  HookMappingConfigInput,
  HooksGmailConfigInput,
  InternalHooksConfigInput,
} from "./zod-schema.hooks.js";
import type { InstallRecordBase } from "./zod-schema.installs.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

export type HookMappingConfig = Omit<HookMappingConfigInput, "channel"> & {
  /** Preserve channel-id autocomplete while allowing runtime plugin channels. */
  channel?: "last" | (string & {});
};

export type HookSessionMode = NonNullable<HookMappingConfigInput["sessionMode"]>;
export type HooksGmailTailscaleMode = NonNullable<
  NonNullable<HooksGmailConfigInput["tailscale"]>["mode"]
>;
export type HookConfig = NonNullable<NonNullable<InternalHooksConfigInput["entries"]>[string]>;

export type HookInstallRecord = InstallRecordBase & {
  hooks?: string[];
};

type HooksSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.hooks>>;

export type HooksConfig = Omit<HooksSchemaInput, "mappings"> & {
  mappings?: HookMappingConfig[];
};

export type HooksImapAccountConfig = {
  email: string;
  host: string;
  port: number;
  secure: boolean;
  mailbox: string;
  /** Optional model override for this IMAP account. */
  model?: string;
  /** Optional thinking level override for this IMAP account. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /** Owner identifier (e.g., Feishu open_id) for delivery target. */
  ownerId?: string;
  /** Owner's channel for delivery (e.g., "feishu"). */
  ownerChannel?: string;
};

export type HooksImapConfig = {
  accounts?: HooksImapAccountConfig[];
  /** Optional model override for IMAP hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for IMAP hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};
