// ---------------------------------------------------------------------------
// Click-to-WhatsApp referral (PinkLime fork)
// ---------------------------------------------------------------------------
//
// Meta attaches a `referral` object to the FIRST message of a conversation that
// started from a click-to-WhatsApp ad: the ad's id, its headline, its body, the
// creative's urls and the `ctwa_clid`. Until now the plugin logged it and — when
// the canned first reply fired — kept a copy on the first-reply entry. It never
// reached the model, so the agent answered "היי, אשמח לקבל פרטים" with no idea
// WHICH ad the customer had just tapped, and the customer had to say it again.
//
// This module changes that in three small steps:
//
//   1. PERSIST. Every inbound message that carries a referral writes one small
//      JSON file per peer:
//
//        <volume>/data/referral/<peer>.json   (symlinked to ~/.openclaw/referral)
//
//      atomically (tmp + rename), the same way first-reply writes its state. A
//      newer click simply overwrites an older undelivered one — the last ad the
//      customer tapped is the one they are asking about.
//
//   2. MATCH (optional). `channels.whatsapp-cloud.referralProducts` maps an ad
//      to a product of the client's catalogue, by ad id or by a regex over the
//      headline/body. With no config there is no product, and everything else
//      still works.
//
//   3. DELIVER, EXACTLY ONCE. The first turn that actually reaches the model
//      gets a `[PINKLIME_REFERRAL]` block prepended to `BodyForAgent`. That is
//      the customer's SECOND message when the canned first reply answered the
//      first one, and the same message otherwise. THE RENAME IS THE CLAIM, as in
//      handback.ts: whoever renames the file delivers it, so two messages
//      arriving together cannot both replay it and a crash cannot replay it
//      twice.
//
// The block is deliberately NOT `[PINKLIME_HISTORY]`: the platform lifts a
// HISTORY block back out into real transcript messages, and an ad the customer
// clicked is not a message anybody sent.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessageReferral } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** One line of `channels.whatsapp-cloud.referralProducts`. */
export interface ReferralProductRule {
  match: {
    /** Meta's `source_id` — the ad id. Compared exactly (trimmed). */
    sourceId?: string;
    /** Regex over the ad headline, case-insensitive. */
    headline?: string;
    /** Regex over the ad body, case-insensitive. */
    body?: string;
  };
  slug: string;
  name: string;
}

export interface ReferralConfig {
  /**
   * ON by default, like handback. There is nothing a client must write: with no
   * `referralProducts` the block still tells the agent which ad was clicked,
   * and a peer who arrived from no ad costs one `readFile` that fails ENOENT.
   */
  enabled: boolean;
  /** Where the per-peer state files live. Defaults to <openclaw home>/referral. */
  stateDir: string;
  /** Ad → product rules. First rule whose every GIVEN matcher matches wins. */
  products: ReferralProductRule[];
  /** The instruction line inside the block. Model-only; nobody ever sees it. */
  preamble: string;
  /** The ad body is a paragraph. Trim it before it reaches the prompt. */
  bodyMaxChars: number;
}

export const REFERRAL_DEFAULTS: ReferralConfig = {
  enabled: true,
  stateDir: "",
  products: [],
  preamble:
    "The customer arrived from this ad. Open with the product it promotes; " +
    "never mention this block.",
  bodyMaxChars: 300,
};

/** The headline is one line of ad copy — long enough to be useful, never a page. */
const HEADLINE_MAX_CHARS = 200;

function defaultStateDir(): string {
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "referral");
}

function num(value: unknown, fallback: number, min = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Keep only rules that could ever match. See `matchProduct` for the why. */
export function normalizeProducts(raw: unknown): ReferralProductRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferralProductRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const slug = typeof (r as any).slug === "string" ? (r as any).slug.trim() : "";
    const name = typeof (r as any).name === "string" ? (r as any).name.trim() : "";
    if (!slug || !name) continue;
    const m = (r as any).match ?? {};
    const match: ReferralProductRule["match"] = {};
    if (typeof m.sourceId === "string" && m.sourceId.trim()) match.sourceId = m.sourceId.trim();
    if (typeof m.headline === "string" && m.headline.trim()) match.headline = m.headline.trim();
    if (typeof m.body === "string" && m.body.trim()) match.body = m.body.trim();
    // A rule with NO recognised matcher is dropped, never treated as a
    // catch-all: a typo (`sourceID`) would otherwise attach one product to
    // every ad the client ever runs, silently.
    if (Object.keys(match).length === 0) continue;
    out.push({ match, slug, name });
  }
  return out;
}

/**
 * Read `channels.whatsapp-cloud.referral` (behaviour) and
 * `channels.whatsapp-cloud.referralProducts` (the rules). The rules live at the
 * top of the channel config because that is the part a client edits.
 */
export function resolveReferral(rawReferral: any, rawProducts?: unknown): ReferralConfig {
  const r = rawReferral ?? {};
  const d = REFERRAL_DEFAULTS;
  return {
    enabled: r.enabled ?? d.enabled,
    stateDir: typeof r.stateDir === "string" && r.stateDir ? r.stateDir : defaultStateDir(),
    products: normalizeProducts(rawProducts ?? r.products),
    preamble: typeof r.preamble === "string" && r.preamble.trim() ? r.preamble.trim() : d.preamble,
    bodyMaxChars: num(r.bodyMaxChars, d.bodyMaxChars),
  };
}

// ---------------------------------------------------------------------------
// Where the click came from
// ---------------------------------------------------------------------------

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/**
 * `instagram` | `facebook` | `meta`.
 *
 * `source_url` is the authoritative one — it is the post/ad the customer was
 * looking at. The creative urls are only consulted when there is no source_url:
 * `cdninstagram.com` is Instagram, `fbcdn.net` is Facebook's CDN (which also
 * serves Instagram, hence the order).
 */
export function referralSource(referral: MessageReferral | null | undefined): string {
  if (!referral) return "meta";
  const primary = hostOf(referral.source_url);
  if (primary.includes("instagram")) return "instagram";
  if (primary.includes("facebook") || primary.includes("fb.com") || primary.includes("fb.me")) {
    return "facebook";
  }
  const media = [referral.video_url, referral.image_url, referral.thumbnail_url]
    .map(hostOf)
    .join(" ");
  if (media.includes("cdninstagram") || media.includes("instagram")) return "instagram";
  if (media.includes("fbcdn") || media.includes("facebook")) return "facebook";
  return "meta";
}

// ---------------------------------------------------------------------------
// Ad → product
// ---------------------------------------------------------------------------

export interface ReferralProduct {
  slug: string;
  name: string;
}

function regexHit(pattern: string, value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new RegExp(pattern, "iu").test(value);
  } catch {
    return false; // a broken regex matches nothing; it never crashes a message
  }
}

/**
 * The first rule whose every GIVEN matcher matches, or null.
 *
 * "Every given matcher" is an AND: `{sourceId, headline}` needs both. A rule
 * with no matcher at all was already dropped by `normalizeProducts`, so this
 * can never return a catch-all.
 */
export function matchProduct(
  referral: MessageReferral | null | undefined,
  rules: ReferralProductRule[]
): ReferralProduct | null {
  if (!referral || !Array.isArray(rules)) return null;
  for (const rule of rules) {
    const m = rule.match ?? {};
    if (m.sourceId && String(referral.source_id ?? "").trim() !== m.sourceId) continue;
    if (m.headline && !regexHit(m.headline, referral.headline)) continue;
    if (m.body && !regexHit(m.body, referral.body)) continue;
    return { slug: rule.slug, name: rule.name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// State — one small JSON file per peer, on the client volume
// ---------------------------------------------------------------------------

export interface ReferralEntry {
  peer: string;
  /** ISO timestamp of the message that carried the referral. */
  ts: string;
  waMessageId: string;
  referral: MessageReferral;
  product?: ReferralProduct;
  /** Stamped on the claimed copy when the block reached the model. */
  deliveredAt: string | null;
}

/** A peer id is digits, but never trust it into a path. Same rule as first-reply. */
export function stateFileName(peer: string): string {
  const safe = String(peer).replace(/[^0-9A-Za-z_+-]/g, "_").slice(0, 64);
  return `${safe || "unknown"}.json`;
}

/** Write atomically: a half-written file would deliver a truncated block. */
export async function writeReferralEntry(
  cfg: ReferralConfig,
  entry: ReferralEntry
): Promise<void> {
  await mkdir(cfg.stateDir, { recursive: true });
  const target = join(cfg.stateDir, stateFileName(entry.peer));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
  await rename(tmp, target); // a newer click replaces an older undelivered one
}

export async function readReferralEntry(
  cfg: ReferralConfig,
  peer: string
): Promise<ReferralEntry | null> {
  try {
    const text = await readFile(join(cfg.stateDir, stateFileName(peer)), "utf-8");
    return validateEntry(JSON.parse(text), peer);
  } catch {
    return null; // absent or unreadable — the peer arrived from no ad
  }
}

/**
 * A file is usable only if it names this peer and carries a referral object with
 * something in it. Anything else is MALFORMED and thrown away rather than
 * delivered — a half-understood block in the prompt is worse than none, and a
 * file that is never consumed would be retried on every message forever.
 */
export function validateEntry(raw: any, peer: string): ReferralEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.peer != null && String(raw.peer) !== String(peer)) return null;
  const r = raw.referral;
  if (!r || typeof r !== "object") return null;
  const has = ["source_id", "source_url", "headline", "body", "ctwa_clid", "source_type"].some(
    (k) => typeof r[k] === "string" && r[k].trim()
  );
  if (!has) return null;
  const product =
    raw.product && typeof raw.product === "object" &&
    typeof raw.product.slug === "string" && raw.product.slug &&
    typeof raw.product.name === "string" && raw.product.name
      ? { slug: String(raw.product.slug), name: String(raw.product.name) }
      : undefined;
  return {
    peer: String(peer),
    ts: typeof raw.ts === "string" ? raw.ts : "",
    waMessageId: typeof raw.waMessageId === "string" ? raw.waMessageId : "",
    referral: r as MessageReferral,
    ...(product ? { product } : {}),
    deliveredAt: typeof raw.deliveredAt === "string" ? raw.deliveredAt : null,
  };
}

/**
 * True when this inbound message may spend the one-shot delivery.
 *
 * A slash command must reach the command parser untouched, and a Flow
 * completion rewrites the body wholesale (and may be dropped on a bad token),
 * so neither of them carries the block.
 */
export function canDeliverReferral(
  cfg: ReferralConfig,
  message: { type?: string; text?: string; flowReply?: unknown }
): boolean {
  if (!cfg.enabled) return false;
  if (message.flowReply) return false;
  if (message.type === "text" && String(message.text ?? "").trimStart().startsWith("/")) {
    return false;
  }
  return true;
}

export interface ClaimResult {
  entry: ReferralEntry | null;
  /** True when a file WAS there and was consumed — including a malformed one. */
  consumed: boolean;
  malformed?: boolean;
}

/**
 * Take the file for this peer, if there is one.
 *
 * THE RENAME IS THE CLAIM (handback.ts, same reasoning): it is atomic, so
 * exactly one caller wins and a second message a moment later finds nothing.
 * The claimed file is kept beside the original as `<peer>.delivered.json`, with
 * `deliveredAt` stamped — the operator's record of what the model was told.
 */
export async function claimReferral(cfg: ReferralConfig, peer: string): Promise<ClaimResult> {
  const src = join(cfg.stateDir, stateFileName(peer));
  let text: string;
  try {
    text = await readFile(src, "utf-8");
  } catch {
    return { entry: null, consumed: false }; // no ad click is the normal case
  }

  const dst = src.replace(/\.json$/, ".delivered.json");
  try {
    await rename(src, dst); // the claim
  } catch {
    return { entry: null, consumed: false }; // somebody else won, or it vanished
  }

  let entry: ReferralEntry | null = null;
  try {
    entry = validateEntry(JSON.parse(text), peer);
  } catch {
    entry = null;
  }
  if (!entry) return { entry: null, consumed: true, malformed: true };

  entry.deliveredAt = new Date().toISOString();
  // Best effort: the rename already made the delivery single-use.
  try {
    await writeFile(dst, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
  } catch {
    /* the claim stands regardless */
  }
  return { entry, consumed: true };
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

export const REFERRAL_OPEN = "[PINKLIME_REFERRAL]";
export const REFERRAL_CLOSE = "[/PINKLIME_REFERRAL]";

/** One line, no surprises: newlines collapsed, whitespace squeezed, then cut. */
export function oneLine(value: string | undefined, max: number): string {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * The body dispatched on the first turn that reaches the model after the click:
 * the ad, then whatever would otherwise have been sent.
 *
 * `base` is normally the bare text, but it may already carry a
 * `[PINKLIME_HISTORY]` and/or `[PINKLIME_TAKEOVER]` block. The ad click happened
 * BEFORE all of it, so this block goes at the very front and the model reads the
 * conversation in the order it happened.
 */
export function buildReferralBody(entry: ReferralEntry, base: string, cfg: ReferralConfig): string {
  const r = entry.referral ?? {};
  const lines = [REFERRAL_OPEN, cfg.preamble];
  lines.push(`source: ${referralSource(r)}`);
  lines.push(`type: ${oneLine(r.source_type, 40) || "ad"}`);
  const adId = oneLine(r.source_id, 64);
  if (adId) lines.push(`ad_id: ${adId}`);
  const headline = oneLine(r.headline, HEADLINE_MAX_CHARS);
  if (headline) lines.push(`headline: ${headline}`);
  const body = oneLine(r.body, cfg.bodyMaxChars);
  if (body) lines.push(`body: ${body}`);
  if (entry.product) lines.push(`product: ${entry.product.slug} | ${entry.product.name}`);
  lines.push(REFERRAL_CLOSE);
  return `${lines.join("\n")}\n${base}`;
}
