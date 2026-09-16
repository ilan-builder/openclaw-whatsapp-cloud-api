// ---------------------------------------------------------------------------
// OpenClaw Channel Plugin — WhatsApp Cloud API
//
// Uses Meta's official WhatsApp Cloud API (graph.facebook.com) instead of
// Baileys. Production-safe for business use: no ban risk, verified numbers,
// template messages, and full compliance with Meta's policies.
//
// Author: Baia Digitale SRL (baiadigitale.com)
// License: MIT
// ---------------------------------------------------------------------------

import type { Server } from "node:http";
import { sendText, sendMedia, sendTypingIndicator, sendFlow } from "./api.js";
import { mintFlowToken, verifyFlowToken } from "./crypto.js";
import { extractDirectives } from "./directives.js";
import { mediaUrlsFromPayload, saveInboundMedia, sendOutboundMedia } from "./media.js";
import { startWebhookServer } from "./webhook.js";
import { runSetupWizard, validateConfig } from "./setup.js";
import { whatsappCloudOnboardingAdapter } from "./onboarding.js";
import type { WhatsAppCloudConfig, Logger } from "./types.js";
import { CONFIG_DEFAULTS } from "./types.js";
import {
  resolveHumanRhythm,
  createReplyPacer,
  splitIntoParts,
  type ReplyPacer,
} from "./human.js";
import {
  setWhatsAppCloudRuntime,
  getWhatsAppCloudRuntime,
  loadRuntimeConfig,
  writeRuntimeConfig,
} from "./runtime.js";
import {
  buildHistoryBody,
  clearEntry,
  commandsAllowedFrom,
  firstName,
  firstReplyStatus,
  firstReplyUsable,
  isExpired,
  isSessionResetCommand,
  maskPeer,
  matchIndex,
  readEntry,
  renderFirstReply,
  resolveFirstReply,
  writeEntry,
  type FirstReplyEntry,
} from "./first-reply.js";
import {
  clearBlock,
  payloadHasMarker,
  readBlock,
  resolveBlock,
  writeBlock,
  type BlockEntry,
} from "./block.js";
import {
  buildTakeoverBody,
  claimHandback,
  resolveHandback,
} from "./handback.js";
import {
  buildReferralBody,
  canDeliverReferral,
  claimReferral,
  matchProduct,
  referralSource,
  resolveReferral,
  writeReferralEntry,
  type ReferralEntry,
  type ReferralProduct,
} from "./referral.js";

// ---------------------------------------------------------------------------
// Account resolution types
// ---------------------------------------------------------------------------

interface ResolvedWhatsAppCloudAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: WhatsAppCloudConfig;
  /** Where the token came from: "config" or "none" */
  tokenSource: string;
}

// Runtime state
let webhookServer: Server | null = null;

// Default account ID constant (matches OpenClaw convention)
const DEFAULT_ACCOUNT_ID = "default";

// ---------------------------------------------------------------------------
// Session key construction
// ---------------------------------------------------------------------------

/**
 * Resolve the id of the default agent from a loaded OpenClaw config.
 * Falls back to "main", which is the runtime's own default agent id.
 */
export function resolveDefaultAgentId(cfg: any): string {
  const list = cfg?.agents?.list;
  if (Array.isArray(list)) {
    const def = list.find((a: any) => a?.default);
    if (def?.id) return String(def.id);
    if (list[0]?.id) return String(list[0].id);
  }
  return "main";
}

/**
 * Build the FULLY canonical session key for an inbound direct message.
 *
 * The gateway's `resolveSessionKey()` uses a ctx-provided `SessionKey`
 * verbatim — it does NOT add the `agent:<id>:` prefix on the inbound path.
 * Anything the store canonicalises later (outbound agent calls, session
 * lookups) uses `agent:<defaultAgentId>:<key>`. Supplying the bare key
 * therefore twins every chat into two sessions:
 *
 *   agent:main:whatsapp-cloud:direct:<peer>   (canonical — outbound writes here)
 *   whatsapp-cloud:direct:<peer>              (bare — inbound turns ran here)
 *
 * Each inbound message could land in a session with no history, so the agent
 * re-greeted the visitor. Emit the canonical form up front so both paths
 * address one session.
 */
export function buildInboundSessionKey(cfg: any, peer: string): string {
  return `agent:${resolveDefaultAgentId(cfg)}:whatsapp-cloud:direct:${peer}`;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(cfg: any): WhatsAppCloudConfig {
  const raw = cfg?.channels?.["whatsapp-cloud"] ?? cfg ?? {};
  return {
    enabled: raw.enabled ?? CONFIG_DEFAULTS.enabled ?? true,
    phoneNumberId: String(raw.phoneNumberId ?? ""),
    businessAccountId: String(raw.businessAccountId ?? ""),
    accessToken: String(raw.accessToken ?? ""),
    appSecret: String(raw.appSecret ?? ""),
    verifyToken: String(raw.verifyToken ?? CONFIG_DEFAULTS.verifyToken!),
    webhookPort: Number(raw.webhookPort ?? CONFIG_DEFAULTS.webhookPort!),
    webhookPath: String(raw.webhookPath ?? CONFIG_DEFAULTS.webhookPath!),
    apiVersion: String(raw.apiVersion ?? CONFIG_DEFAULTS.apiVersion!),
    dmPolicy: raw.dmPolicy ?? CONFIG_DEFAULTS.dmPolicy!,
    allowFrom: raw.allowFrom ?? CONFIG_DEFAULTS.allowFrom!,
    sendReadReceipts: raw.sendReadReceipts ?? CONFIG_DEFAULTS.sendReadReceipts!,
    flows: raw.flows ?? {},
    humanRhythm: resolveHumanRhythm(raw.humanRhythm),
    firstReply: resolveFirstReply(raw.firstReply),
    handback: resolveHandback(raw.handback),
    referral: resolveReferral(raw.referral, raw.referralProducts),
    block: resolveBlock(raw.block),
    referralProducts: Array.isArray(raw.referralProducts) ? raw.referralProducts : [],
  };
}

function resolveAccount(cfg: any, accountId?: string | null): ResolvedWhatsAppCloudAccount {
  const channelCfg = cfg?.channels?.["whatsapp-cloud"] ?? {};
  const config = resolveConfig(cfg);
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name: channelCfg.name,
    enabled: config.enabled,
    config,
    tokenSource: config.accessToken ? "config" : "none",
  };
}

// PinkLime fork: deliver reply text honoring trailing directives (FLOW: <name>).
async function deliverText(
  config: WhatsAppCloudConfig,
  to: string,
  text: string,
  log: Logger,
  pacer?: ReplyPacer
): Promise<{ ok: boolean; messageId?: string; error?: string } | null> {
  const { text: clean, flows } = extractDirectives(text);
  let result: { ok: boolean; messageId?: string; error?: string } | null = null;
  if (clean) {
    // One reply written as two paragraphs is two WhatsApp messages, sent with a
    // gap, the way a person texts. Without a pacer it stays one message.
    const parts = pacer ? splitIntoParts(clean, config.humanRhythm) : [clean];
    let lastSent: { ok: boolean; messageId?: string; error?: string } | null = null;
    for (const part of parts) {
      await pacer?.beforeSend();
      const sent = await sendText(config, to, part, log);
      result = result ?? sent;
      lastSent = sent;
    }
    // Failures already log from sendRequest (src/api.ts); this is the only
    // line that confirms a reply actually reached the customer.
    if (lastSent?.ok) {
      const masked = maskPeer(to);
      log.info(
        parts.length > 1
          ? `[whatsapp-cloud] → sent ${parts.length} part(s) to ${masked} (${lastSent.messageId})`
          : `[whatsapp-cloud] → sent to ${masked} (${lastSent.messageId})`
      );
    }
  }
  for (const name of flows) {
    const flow = config.flows?.[name];
    if (!flow?.flowId) {
      log.warn(`[whatsapp-cloud] Unknown flow "${name}" — directive dropped`);
      continue;
    }
    await pacer?.beforeSend();
    const token = mintFlowToken({ f: name, p: to, t: Date.now() }, config.appSecret);
    const fr = await sendFlow(config, to, flow, token, log);
    if (!fr.ok) log.error(`[whatsapp-cloud] Flow send failed (${name}): ${fr.error}`);
    result = result ?? fr;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Channel plugin definition
// Follows the ChannelPlugin<ResolvedAccount> interface from OpenClaw SDK
// ---------------------------------------------------------------------------

const whatsappCloudChannel = {
  id: "whatsapp-cloud" as string,

  meta: {
    id: "whatsapp-cloud" as string,
    label: "WhatsApp Cloud API",
    selectionLabel: "WhatsApp (Meta Cloud API)",
    docsPath: "/channels/whatsapp-cloud",
    docsLabel: "whatsapp-cloud",
    blurb:
      "WhatsApp via Meta's official Cloud API. Production-safe for business — no Baileys, no ban risk.",
    aliases: ["wa-cloud", "whatsapp-business", "wa-business"],
    preferOver: ["whatsapp"],
    quickstartAllowFrom: true,
  },

  onboarding: whatsappCloudOnboardingAdapter,

  capabilities: {
    chatTypes: ["direct"] as Array<"direct">,
    media: true,
    blockStreaming: true,
  },

  reload: { configPrefixes: ["channels.whatsapp-cloud"] },

  // ---- Config adapter ----
  config: {
    listAccountIds: (cfg: any): string[] =>
      cfg?.channels?.["whatsapp-cloud"]?.enabled !== false ? [DEFAULT_ACCOUNT_ID] : [],

    resolveAccount: (cfg: any, accountId?: string | null): ResolvedWhatsAppCloudAccount =>
      resolveAccount(cfg, accountId),

    defaultAccountId: (_cfg: any): string => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: any; accountId: string; enabled: boolean }): any => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "whatsapp-cloud": {
          ...cfg.channels?.["whatsapp-cloud"],
          enabled,
        },
      },
    }),

    deleteAccount: ({ cfg, accountId }: { cfg: any; accountId: string }): any => {
      const next = { ...cfg };
      const nextChannels = { ...next.channels };
      delete nextChannels["whatsapp-cloud"];
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },

    isConfigured: (account: ResolvedWhatsAppCloudAccount): boolean =>
      Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),

    describeAccount: (account: ResolvedWhatsAppCloudAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),
      tokenSource: account.tokenSource,
    }),

    resolveAllowFrom: ({ cfg }: { cfg: any; accountId?: string | null }) =>
      (cfg?.channels?.["whatsapp-cloud"]?.allowFrom ?? []).map((entry: any) => String(entry)),

    formatAllowFrom: ({ allowFrom }: { cfg: any; accountId?: string | null; allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/[^0-9+]/g, "")),
  },

  // ---- Security adapter ----
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }: { cfg: any; accountId?: string | null; account: ResolvedWhatsAppCloudAccount }) => ({
      policy: account.config.dmPolicy ?? "open",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.whatsapp-cloud.dmPolicy",
      allowFromPath: "channels.whatsapp-cloud.",
      approveHint: "openclaw pairing approve whatsapp-cloud <code>",
      normalizeEntry: (raw: string) => raw.replace(/[^0-9]/g, ""),
    }),
  },

  // ---- Pairing ----
  pairing: {
    idLabel: "whatsappPhoneNumber",
    normalizeAllowEntry: (entry: string) => entry.replace(/[^0-9]/g, ""),
    notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
      const config = resolveConfig(cfg);
      if (!config.accessToken) {
        throw new Error("WhatsApp Cloud access token not configured");
      }
      const log: Logger = console as unknown as Logger;
      await sendText(config, id, "OpenClaw: your access has been approved.", log);
    },
  },

  // ---- Setup adapter (for `openclaw channels login whatsapp-cloud`) ----
  setup: {
    resolveAccountId: ({ accountId }: { cfg: any; accountId?: string }) =>
      accountId ?? DEFAULT_ACCOUNT_ID,

    validateInput: ({ accountId, input }: { cfg: any; accountId: string; input: any }) => {
      if (!input.accessToken && !input.token) {
        return "WhatsApp Cloud API requires an access token. Use --token <access-token>.";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }: { cfg: any; accountId: string; input: any }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "whatsapp-cloud": {
          ...cfg.channels?.["whatsapp-cloud"],
          enabled: true,
          ...(input.name ? { name: input.name } : {}),
          ...(input.accessToken ? { accessToken: input.accessToken } : {}),
          ...(input.token ? { accessToken: input.token } : {}),
          ...(input.webhookPath ? { webhookPath: input.webhookPath } : {}),
          ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
        },
      },
    }),
  },

  // ---- Outbound adapter ----
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,

    sendText: async ({ cfg, to, text, accountId }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      replyToId?: string | null;
      threadId?: string | number | null;
      accountId?: string | null;
      deps?: any;
      silent?: boolean;
    }) => {
      const config = resolveConfig(cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      const result = await deliverText(config, to, text, log);

      if (result && !result.ok) {
        throw new Error(`WhatsApp Cloud API send failed: ${result.error}`);
      }

      return {
        channel: "whatsapp-cloud" as any,
        messageId: result?.messageId ?? "unknown",
        chatId: to,
      };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
    }) => {
      const config = resolveConfig(cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      if (mediaUrl) {
        const result = await sendOutboundMedia(config, to, mediaUrl, text || undefined, log);
        if (!result.ok) {
          throw new Error(`WhatsApp Cloud API media send failed: ${result.error}`);
        }
        return {
          channel: "whatsapp-cloud" as any,
          messageId: result.messageId ?? "unknown",
          chatId: to,
        };
      }

      // Fallback to text if no media URL
      const result = await sendText(config, to, text, log);
      if (!result.ok) {
        throw new Error(`WhatsApp Cloud API send failed: ${result.error}`);
      }
      return {
        channel: "whatsapp-cloud" as any,
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },
  },

  // ---- Gateway lifecycle ----
  gateway: {
    startAccount: async (ctx: any) => {
      const account: ResolvedWhatsAppCloudAccount = ctx.account;
      const config = account.config;
      const log: Logger = ctx.log ?? console as unknown as Logger;
      const runtime = getWhatsAppCloudRuntime();

      if (!config.enabled) {
        log.info?.("[whatsapp-cloud] Channel is disabled");
        return;
      }

      // Validate config
      const validation = validateConfig(config);
      if (!validation.valid) {
        for (const err of validation.errors) {
          log.error(`[whatsapp-cloud] Config error: ${err}`);
        }
        log.error("[whatsapp-cloud] Run 'openclaw channels login whatsapp-cloud' to configure");
        return;
      }
      for (const warn of validation.warnings) {
        log.warn(`[whatsapp-cloud] ${warn}`);
      }

      // PinkLime fork: a previous instance may still hold the port (the
      // runtime restarts accounts); close it before binding again.
      if (webhookServer) {
        try {
          webhookServer.close();
        } catch {
          // already closed
        }
        webhookServer = null;
      }

      // Start the webhook HTTP server
      webhookServer = startWebhookServer(
        config,
        // Inbound message handler — dispatch into OpenClaw agent session
        async (message) => {
          // Reply pacing (PinkLime fork). The clock starts here, when the customer
          // pressed send, so the wait covers model generation instead of adding to it.
          const rhythm = config.humanRhythm;
          // A blocked peer reaches this handler for exactly one reason — they
          // sent `/new` or `/reset` (webhook.ts) — and nobody is going to write
          // back to them, so no pacing and no typing indicator either way.
          const pacer: ReplyPacer | undefined =
            rhythm.enabled && !message.blocked
              ? createReplyPacer({ config, rhythm, messageId: message.messageId, log })
              : undefined;
          if (!pacer && !message.blocked) {
            // Show typing indicator immediately (auto-dismissed on reply or after 25s)
            sendTypingIndicator(config, message.messageId, log).catch(() => {});
          }
          try {

            // Load fresh config for dispatch
            const freshCfg = await loadRuntimeConfig(runtime);
            const sessionKey = buildInboundSessionKey(freshCfg, message.from);

            // ---------------------------------------------------------------
            // Troll block — lifting your own block (PinkLime fork)
            //
            // `message.blocked` is set by the block gate in webhook.ts and by
            // nothing else: this peer is blocked and sent `/new` or `/reset`,
            // the one message the gate lets through. Whoever may run commands
            // here may also lift their own block — that is how the feature is
            // tested from a real phone.
            //
            // An unauthorized peer stops here and the model is never called;
            // an authorized one falls through, so the reset they asked for also
            // actually happens. See block.ts.
            // ---------------------------------------------------------------
            if (message.blocked) {
              if (!commandsAllowedFrom(freshCfg, message.from)) {
                log.info(
                  `[block] ignored a session reset from blocked ${maskPeer(message.from)} — not allowed to run commands`
                );
                return;
              }
              const lifted = await clearBlock(config.block, message.from);
              log.info(
                `[block] ${lifted ? "lifted" : "already clear"} for ${maskPeer(message.from)} after a session reset`
              );
            }

            // ---------------------------------------------------------------
            // Click-to-WhatsApp referral — persist (PinkLime fork)
            //
            // Meta attaches the ad's id, headline and body to the FIRST message
            // of a conversation started from an ad. Write it down before
            // anything else can return: the canned first reply answers that very
            // message without the model, so the block has to survive until the
            // customer's SECOND message. A newer click overwrites an older
            // undelivered one. See referral.ts.
            // ---------------------------------------------------------------
            const rf = config.referral;
            let referralProduct: ReferralProduct | null = null;
            if (rf.enabled && message.referral) {
              referralProduct = matchProduct(message.referral, rf.products);
              const inboundTs = Number(message.timestamp) * 1000;
              const entry: ReferralEntry = {
                peer: message.from,
                ts: new Date(
                  Number.isFinite(inboundTs) && inboundTs > 0 ? inboundTs : Date.now()
                ).toISOString(),
                waMessageId: message.messageId,
                referral: message.referral,
                ...(referralProduct ? { product: referralProduct } : {}),
                deliveredAt: null,
              };
              try {
                await writeReferralEntry(rf, entry);
                log.info(
                  `[referral] ${maskPeer(message.from)} ad=${message.referral.source_id ?? "-"} ` +
                    `src=${referralSource(message.referral)} product=${referralProduct?.slug ?? "none"}`
                );
              } catch (err) {
                log.error(`[referral] state write failed for ${maskPeer(message.from)}: ${err}`);
              }
            }

            // ---------------------------------------------------------------
            // A session reset makes the peer new again (PinkLime fork)
            //
            // `/new` means "start this conversation over", and the canned
            // greeting is part of the start. The command itself still goes
            // through untouched — this only drops the state file, so the next
            // matching opener is answered without the model again.
            // ---------------------------------------------------------------
            if (
              message.type === "text" &&
              config.firstReply.enabled &&
              isSessionResetCommand(message.text) &&
              commandsAllowedFrom(freshCfg, message.from)
            ) {
              const cleared = await clearEntry(config.firstReply, message.from);
              if (cleared) {
                log.info(`[first-reply] cleared ${maskPeer(message.from)} after a session reset`);
              }
            }

            // ---------------------------------------------------------------
            // Canned first reply (PinkLime fork)
            //
            // The known ad opener is answered without the model, and the model
            // is called only from the customer's SECOND message — with the two
            // earlier messages replayed into the body, so the agent continues
            // instead of greeting a second time. See first-reply.ts.
            // ---------------------------------------------------------------
            let historyBody: string | null = null;
            const fr = config.firstReply;
            // A slash command is not a conversation turn. It must reach the
            // command parser untouched, and it must not spend a one-shot replay.
            const slashCommand =
              message.type === "text" && message.text.trimStart().startsWith("/");
            const plainText =
              message.type === "text" &&
              !message.media &&
              !message.flowReply &&
              !message.interactiveReply &&
              !slashCommand;
            if (firstReplyUsable(fr) && plainText) {
              const existing = await readEntry(fr, message.from);
              const stale = existing ? isExpired(existing, fr.cooldownDays) : true;
              if (existing && !stale && existing.continuedAt === null) {
                // They came back. Replay the canned exchange into this turn and
                // mark the entry, so it is replayed exactly once.
                historyBody = buildHistoryBody(existing, message.text, fr.historyPreamble);
                const sinceMs = Date.now() - Date.parse(existing.reply?.ts ?? "");
                const since = Number.isFinite(sinceMs) ? Math.round(sinceMs / 1000) : -1;
                try {
                  await writeEntry(fr, { ...existing, continuedAt: new Date().toISOString() });
                } catch (err) {
                  log.error(`[first-reply] state write failed for ${maskPeer(message.from)}: ${err}`);
                }
                log.info(`[first-reply] continued ${maskPeer(message.from)} after ${since}s`);
              } else if (!existing || stale) {
                const idx = matchIndex(message.text, fr.match);
                if (idx >= 0) {
                  const name = firstName(message.senderName);
                  // A matched ad selects the referralText pair, when the client
                  // wrote one. Without it this is exactly today's render.
                  const text = renderFirstReply(fr, name, referralProduct);
                  // Belt and braces: firstReplyUsable() already refuses a config
                  // with nothing to say. An empty WhatsApp message is worse than
                  // no saving, so an empty render falls through to the model.
                  const sent = text
                    ? await deliverText(config, message.from, text, log, pacer)
                    : null;
                  if (!text) {
                    log.warn(
                      `[first-reply] rendered an empty reply for ${maskPeer(message.from)} — falling through to the model`
                    );
                  }
                  if (sent?.ok) {
                    const inboundTs = Number(message.timestamp) * 1000;
                    const entry: FirstReplyEntry = {
                      peer: message.from,
                      senderName: message.senderName ?? null,
                      inbound: {
                        text: message.text,
                        ts: new Date(
                          Number.isFinite(inboundTs) && inboundTs > 0 ? inboundTs : Date.now()
                        ).toISOString(),
                        waMessageId: message.messageId,
                        ...(message.referral ? { referral: message.referral } : {}),
                      },
                      reply: { text, ts: new Date().toISOString(), waMessageId: sent.messageId },
                      continuedAt: null,
                      sessionKey,
                    };
                    try {
                      await writeEntry(fr, entry);
                    } catch (err) {
                      log.error(`[first-reply] state write failed for ${maskPeer(message.from)}: ${err}`);
                    }
                    log.info(`[first-reply] sent to ${maskPeer(message.from)} match=${idx}`);
                    return; // the model is never called for this message
                  }
                  // The canned send failed. Record nothing and let the model
                  // answer, exactly as it did before this feature existed.
                  if (text) {
                    log.error(
                      `[first-reply] canned send failed for ${maskPeer(message.from)}: ${sent?.error ?? "no result"} — falling through to the model`
                    );
                  }
                }
              }
            }

            // ---------------------------------------------------------------
            // The hand-back replay (PinkLime fork)
            //
            // A human held this chat and handed it back. The container was given
            // NOTHING while they held it, so the turns of the hold are replayed
            // into this one prompt — otherwise the model answers the customer
            // about a conversation it has no record of. See handback.ts.
            //
            // `plainText` is the same guard firstReply uses, and for the same two
            // reasons: a slash command must reach the parser untouched, and it
            // must not spend the one replay. A media message leaves the file in
            // place for the next text message.
            // ---------------------------------------------------------------
            const hb = config.handback;
            if (hb.enabled && plainText) {
              const claim = await claimHandback(hb, message.from);
              if (claim.malformed) {
                log.warn(
                  `[takeover] discarded a malformed hand-back file for ${maskPeer(message.from)} — the model was told nothing`
                );
              } else if (claim.entry) {
                // Composes with the firstReply block when both are due: that one
                // is older, so it stays in front (buildTakeoverBody).
                historyBody = buildTakeoverBody(claim.entry, historyBody ?? message.text);
                log.info(
                  `[takeover] replayed ${claim.entry.turns.length} turn(s) of a hand-back to ${maskPeer(message.from)}` +
                    (claim.entry.heldBy ? ` (held by ${claim.entry.heldBy})` : "")
                );
              }
            }

            // ---------------------------------------------------------------
            // Click-to-WhatsApp referral — deliver, exactly once (PinkLime fork)
            //
            // This is the first turn that actually reaches the model since the
            // click: the customer's SECOND message when the canned first reply
            // answered the first one (the `return` above never gets here), and
            // the same message otherwise. THE RENAME IS THE CLAIM, so a later
            // message never replays it.
            //
            // The block goes at the very FRONT — the ad click happened before
            // the canned exchange and before any hand-back, so the model reads
            // the conversation in the order it happened.
            //
            // A slash command must reach the parser untouched and must not spend
            // the delivery; a Flow completion rewrites the body wholesale below
            // and can be dropped on a bad token, so it does not spend it either.
            // ---------------------------------------------------------------
            if (canDeliverReferral(rf, message)) {
              const claim = await claimReferral(rf, message.from);
              if (claim.malformed) {
                log.warn(
                  `[referral] discarded a malformed referral file for ${maskPeer(message.from)} — the model was told nothing`
                );
              } else if (claim.entry) {
                historyBody = buildReferralBody(claim.entry, historyBody ?? message.text, rf);
                log.info(`[referral] delivered to agent for ${maskPeer(message.from)}`);
              }
            }

            // Build MsgContext (OpenClaw's standard inbound message format)
            const msgCtx: Record<string, any> = {
              Body: message.text,
              RawBody: message.text,
              CommandBody: message.text,
              BodyForCommands: message.text,
              // The replayed history rides on BodyForAgent, which the runtime
              // reads FIRST for the model's prompt (resolveAcpPromptText:
              // BodyForAgent -> BodyForCommands -> CommandBody -> RawBody ->
              // Body). Everything else keeps the bare text, so command parsing
              // and the channel's own bookkeeping are untouched.
              ...(historyBody ? { BodyForAgent: historyBody } : {}),
              From: message.from,
              To: config.phoneNumberId,
              // OpenClaw session keys are "agent:<agentId>:<channel>:<chatType>:<peer>".
              // The gateway does NOT prefix a ctx-provided SessionKey on the inbound path —
              // it uses it verbatim — while the store canonicalises everything else to the
              // "agent:<id>:…" form. Emit the fully canonical key so inbound turns and
              // outbound agent calls share one session. See buildInboundSessionKey().
              SessionKey: sessionKey,
              AccountId: account.accountId,
              MessageSid: message.messageId,
              ChatType: "direct",
              SenderName: message.senderName,
              SenderId: message.from,
              Provider: "whatsapp-cloud",
              OriginatingChannel: "whatsapp-cloud",
              OriginatingTo: message.from,
              Timestamp: parseInt(message.timestamp, 10) * 1000,
            };

            if (message.quotedMessageId) {
              msgCtx.ReplyToId = message.quotedMessageId;
            }

            // PinkLime fork: Flow completion → verified structured line.
            if (message.flowReply) {
              let parsed: Record<string, unknown> = {};
              try { parsed = JSON.parse(message.flowReply.responseJson); } catch { /* keep {} */ }
              const token = String(parsed.flow_token ?? "");
              const ver = verifyFlowToken(token, config.appSecret);
              if (!ver || ver.p !== message.from) {
                log.warn(`[whatsapp-cloud] Flow completion with invalid/mismatched token from ${message.from} — dropped`);
                return;
              }
              delete parsed.flow_token;
              const structured = `[FLOW_RESPONSE ${ver.f}] ${JSON.stringify(parsed)}`;
              msgCtx.Body = structured;
              msgCtx.RawBody = structured;
              msgCtx.CommandBody = structured;
              msgCtx.BodyForCommands = structured;
            }

            // PinkLime fork: download inbound media to a local file so the
            // runtime's media tools run (voice transcription, image input).
            if (message.media) {
              const saved = await saveInboundMedia(config, message.media, message.messageId, log);
              if (saved) {
                msgCtx.MediaPath = saved.path;
                msgCtx.MediaPaths = [saved.path];
                msgCtx.MediaContentType = saved.mimeType;
                msgCtx.MediaType = message.type;
                msgCtx.NumMedia = "1";
              } else {
                log.warn(
                  `[whatsapp-cloud] Media download failed for ${message.messageId} — dispatching text placeholder only`
                );
              }
            }

            // ---------------------------------------------------------------
            // Troll block — the agent's verdict (PinkLime fork)
            //
            // The agent answers a troll with one marker and nothing else. The
            // verdict covers the WHOLE turn, not the one payload it arrives in:
            // the runtime hands the channel one payload per block of the reply,
            // and `humanRhythm` then splits a single payload into several
            // WhatsApp messages on blank lines. A check that only suppressed the
            // payload it found the marker in would let the rest of the reply —
            // and any media with it — reach the troll.
            //
            // So the marker is looked for in each payload BEFORE anything is
            // split or sent, and once it is found nothing else leaves for the
            // rest of the turn. The block file is written afterwards, from one
            // place, so a failed write cannot half-apply it. See block.ts.
            // ---------------------------------------------------------------
            const blk = config.block;
            const verdict: { hit: boolean; reason: string | null } = { hit: false, reason: null };

            // Dispatch via OpenClaw's reply system
            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: freshCfg,
              dispatcherOptions: {
                deliver: async (payload: any) => {
                  if (blk.enabled) {
                    if (!verdict.hit) {
                      const marked = payloadHasMarker(payload, blk.marker);
                      if (marked.found) {
                        verdict.hit = true;
                        verdict.reason = marked.reason;
                        // Stop the typing indicator now: a reply that is never
                        // coming must not keep announcing itself.
                        pacer?.stop();
                      }
                    }
                    if (verdict.hit) return; // no text, no media, nothing
                  }
                  if (payload.text) {
                    await deliverText(config, message.from, payload.text, log, pacer);
                  }
                  // One de-duplicated list: the runtime sets mediaUrls AND
                  // mediaUrl for a single attachment, and handling both fields
                  // sent the same photo twice.
                  for (const url of mediaUrlsFromPayload(payload)) {
                    await pacer?.beforeSend();
                    const sent = await sendOutboundMedia(config, message.from, url, undefined, log);
                    if (!sent.ok) {
                      log.error(`[whatsapp-cloud] Media send failed (${url}): ${sent.error}`);
                    }
                  }
                },
                onReplyStart: () => {
                  log.info?.(`[whatsapp-cloud] Generating reply for ${message.senderName} (${message.from})`);
                },
              },
            });

            // The turn is over and the customer got nothing. Write the block, so
            // the NEXT message from this number is dropped in webhook.ts, before
            // the read receipt and long before the model.
            if (verdict.hit) {
              const entry: BlockEntry = {
                peer: message.from,
                reason: verdict.reason,
                source: "bot",
                blockedAt: new Date().toISOString(),
                blockedBy: resolveDefaultAgentId(freshCfg) ?? null,
                triggerText: message.text ? message.text.slice(0, 500) : null,
                sessionKey,
              };
              try {
                await writeBlock(blk, entry);
                log.warn(
                  `[block] BLOCKED ${maskPeer(message.from)} by the agent` +
                    `${verdict.reason ? ` (${verdict.reason})` : ""} — the reply was suppressed`
                );
              } catch (err) {
                // The reply was already withheld, so the troll got nothing this
                // turn; only the NEXT one will cost a prompt. Loud, not fatal.
                log.error(`[block] state write failed for ${maskPeer(message.from)}: ${err}`);
              }
            }
          } catch (err) {
            log.error(`[whatsapp-cloud] Failed to dispatch inbound message: ${err}`);
          } finally {
            pacer?.stop();
          }
        },
        // Status update handler
        (messageId, status, recipientId) => {
          log.debug?.(`[whatsapp-cloud] Status: ${status} for message ${messageId} to ${recipientId}`);
        },
        log
      );

      log.info("[whatsapp-cloud] Channel started");
      log.info(`[whatsapp-cloud]   Webhook: http://localhost:${config.webhookPort}${config.webhookPath}`);
      log.info(`[whatsapp-cloud]   DM Policy: ${config.dmPolicy}`);
      if (config.dmPolicy === "allowlist") {
        log.info(`[whatsapp-cloud]   Allowed: ${config.allowFrom.join(", ") || "(none)"}`);
      }
      // ONE line, at startup: the base layer turns firstReply on for everyone,
      // so "on but with no text" is a real state and must be visible here.
      {
        const status = firstReplyStatus(config.firstReply);
        if (status.active) log.info(status.line);
        else log.warn(status.line);
      }
      // Only when the client actually wrote rules: the referral block itself
      // needs no config, so silence here means "no ad → product mapping".
      if (config.referral.enabled && config.referral.products.length > 0) {
        log.info(`[referral] ${config.referral.products.length} product rule(s) configured`);
      }

      // Update runtime status
      if (typeof ctx.setStatus === "function") {
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lastStartAt: Date.now(),
          mode: "webhook",
        });
      }

      // PinkLime fork: the runtime treats a resolved startAccount as "channel
      // exited" and auto-restarts it (EADDRINUSE loop on the webhook port).
      // Stay resident until the runtime aborts the account.
      const signal: AbortSignal | undefined = ctx.abortSignal ?? ctx.signal;
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          if (webhookServer) {
            try {
              webhookServer.close();
            } catch {
              // already closed
            }
            webhookServer = null;
          }
          log.info?.("[whatsapp-cloud] Channel stopped");
          resolve();
        };
        if (signal) {
          if (signal.aborted) return shutdown();
          signal.addEventListener("abort", shutdown, { once: true });
        }
        // No abort signal from this runtime version: never resolve — the
        // webhook server IS the running channel; process exit tears it down.
      });
    },

    logoutAccount: async ({ accountId, cfg }: { accountId: string; cfg: any }) => {
      // Stop webhook if running
      if (webhookServer) {
        webhookServer.close();
        webhookServer = null;
      }

      // Clear credentials from config
      const nextCfg = { ...cfg };
      const waCloudCfg = cfg.channels?.["whatsapp-cloud"];
      if (waCloudCfg) {
        const { accessToken, appSecret, ...rest } = waCloudCfg;
        nextCfg.channels = {
          ...nextCfg.channels,
          "whatsapp-cloud": rest,
        };

        await writeRuntimeConfig(nextCfg);
      }

      return {
        cleared: Boolean(waCloudCfg?.accessToken),
        loggedOut: true,
      };
    },
  },

  // ---- Status adapter ----
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    collectStatusIssues: (accounts: any[]) => {
      const issues: any[] = [];
      for (const account of accounts) {
        const aid = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.config?.accessToken?.trim()) {
          issues.push({
            channel: "whatsapp-cloud",
            accountId: aid,
            kind: "config",
            message: "WhatsApp Cloud API access token not configured",
          });
        }
        if (!account.config?.phoneNumberId?.trim()) {
          issues.push({
            channel: "whatsapp-cloud",
            accountId: aid,
            kind: "config",
            message: "WhatsApp Cloud API phone number ID not configured",
          });
        }
      }
      return issues;
    },

    buildAccountSnapshot: ({ account, runtime }: { account: ResolvedWhatsAppCloudAccount; cfg: any; runtime?: any }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? (webhookServer?.listening ?? false),
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: "webhook",
    }),
  },
};

// ---------------------------------------------------------------------------
// Plugin definition (OpenClawPluginDefinition)
// ---------------------------------------------------------------------------

const plugin = {
  id: "openclaw-whatsapp-cloud-api",
  name: "WhatsApp Cloud API",
  description: "WhatsApp Cloud API channel plugin — official Meta Business API, no Baileys",

  register(api: any) {
    const log: Logger = api.logger ?? (console as unknown as Logger);
    log.info("[whatsapp-cloud] Loading WhatsApp Cloud API channel plugin");

    // Store runtime reference for dispatch and config access
    setWhatsAppCloudRuntime(api.runtime);

    // Register the channel
    api.registerChannel({ plugin: whatsappCloudChannel });

    // Register CLI commands: `openclaw whatsapp-cloud setup|status|test`
    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }: any) => {
          const cmd = program
            .command("whatsapp-cloud")
            .description("WhatsApp Cloud API channel management");

          cmd
            .command("setup")
            .description("Interactive setup wizard for WhatsApp Cloud API credentials")
            .action(async () => {
              try {
                const result = await runSetupWizard(undefined, log);

                // Save via runtime config
                try {
                  const runtime = getWhatsAppCloudRuntime();
                  const currentCfg = await loadRuntimeConfig(runtime);
                  const nextCfg = {
                    ...currentCfg,
                    channels: {
                      ...currentCfg.channels,
                      "whatsapp-cloud": {
                        ...currentCfg.channels?.["whatsapp-cloud"],
                        enabled: true,
                        phoneNumberId: result.phoneNumberId,
                        ...(result.businessAccountId ? { businessAccountId: result.businessAccountId } : {}),
                        accessToken: result.accessToken,
                        ...(result.appSecret ? { appSecret: result.appSecret } : {}),
                        verifyToken: result.verifyToken,
                        webhookPort: result.webhookPort,
                        webhookPath: result.webhookPath,
                        dmPolicy: result.dmPolicy,
                      },
                    },
                  };
                  await writeRuntimeConfig(nextCfg, runtime);
                  log.info("[whatsapp-cloud] Configuration saved to openclaw.json");
                  console.log("\n  Then: openclaw gateway restart\n");
                } catch {
                  // Fallback: print commands for manual config
                  console.log("\nRun these commands to save your config:\n");
                  console.log(`  openclaw config set channels.whatsapp-cloud.enabled true`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.phoneNumberId "${result.phoneNumberId}"`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.accessToken "${result.accessToken}"`);
                  if (result.appSecret) {
                    console.log(`  openclaw config set channels.whatsapp-cloud.appSecret "${result.appSecret}"`);
                  }
                  console.log(`  openclaw config set channels.whatsapp-cloud.verifyToken "${result.verifyToken}"`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.webhookPort ${result.webhookPort}`);
                  console.log(`\n  Then: openclaw gateway restart\n`);
                }
              } catch (err) {
                log.error(`Setup failed: ${err}`);
                process.exit(1);
              }
            });

          cmd
            .command("status")
            .description("Check WhatsApp Cloud API channel health")
            .action(async () => {
              const isRunning = webhookServer !== null && webhookServer.listening;
              console.log(`WhatsApp Cloud API: ${isRunning ? "OK" : "Not running"}`);
              console.log(`  Webhook server: ${isRunning ? "running" : "not running"}`);

              try {
                const runtime = getWhatsAppCloudRuntime();
                const cfg = await loadRuntimeConfig(runtime);
                const config = resolveConfig(cfg);
                const validation = validateConfig(config);
                if (!validation.valid) {
                  for (const err of validation.errors) {
                    console.log(`  Config error: ${err}`);
                  }
                }
                for (const warn of validation.warnings) {
                  console.log(`  Warning: ${warn}`);
                }
              } catch {
                console.log("  (could not load config)");
              }
            });

          cmd
            .command("test")
            .description("Send a test message to verify configuration")
            .argument("<phone>", "Recipient phone in E.164 format (e.g., +393491234567)")
            .action(async (phone: string) => {
              try {
                const runtime = getWhatsAppCloudRuntime();
                const cfg = await loadRuntimeConfig(runtime);
                const config = resolveConfig(cfg);

                if (!config.accessToken || !config.phoneNumberId) {
                  log.error("Missing config. Run 'openclaw whatsapp-cloud setup' first.");
                  process.exit(1);
                }

                const result = await sendText(
                  config,
                  phone.replace("+", ""),
                  "Hello from OpenClaw! Your WhatsApp Cloud API channel is working.",
                  log
                );

                if (result.ok) {
                  console.log(`Test message sent to ${phone} (ID: ${result.messageId})`);
                } else {
                  console.log(`Failed: ${result.error}`);
                  process.exit(1);
                }
              } catch (err) {
                log.error(`Test failed: ${err}`);
                process.exit(1);
              }
            });
        },
        { commands: ["whatsapp-cloud"] }
      );
    }

    log.info("[whatsapp-cloud] Plugin registered");
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { sendText, sendTemplate, sendInteractive, sendButtons, sendMedia } from "./api.js";
export { markAsRead, sendTypingIndicator, getMediaUrl, downloadMedia } from "./api.js";
export { runSetupWizard, validateConfig } from "./setup.js";
export type { WhatsAppCloudConfig } from "./types.js";
export type { ParsedInboundMessage, ParsedInboundMessage as InboundMessage } from "./webhook.js";
export { whatsappCloudOnboardingAdapter } from "./onboarding.js";
