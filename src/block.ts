// ---------------------------------------------------------------------------
// Troll block (PinkLime fork)
// ---------------------------------------------------------------------------
//
// Two real porcini conversations cost $0.33 and $0.37 to be insulted and fed
// fake event details. Both ended with the bot handing a worthless lead to the
// team. Nothing in the pipeline could stop them: every inbound message is a
// full cold prompt, and the model is the only thing that can tell a customer
// from a troll.
//
// So the BOT decides, and the PLATFORM enforces. The agent's prompt is told to
// answer a troll with one marker and nothing else. When a reply carries that
// marker the channel:
//
//   1. sends the customer NOTHING — not the marker, not any text around it,
//      and no media that came with it,
//   2. writes a block file for that peer,
//   3. and from then on drops the peer's messages as early as it can, BEFORE
//      the read receipt and before the typing indicator, so the troll cannot
//      even see that they were read.
//
// A blocked message costs zero tokens: it never reaches the runtime at all.
//
// Two files per peer, both on the client volume:
//
//   <volume>/data/blocked/<peer>.json    the block itself
//   <volume>/data/blocked/<peer>.jsonl   every message dropped since
//
// The `.jsonl` exists so a block is never a black hole: the sync worker merges
// those lines back into the transcript, flagged, so an operator can read what
// the blocked number kept sending and decide the bot got it wrong.
//
// The block file is read fresh for EVERY inbound message — no cache. An
// operator who unmutes a number from the dashboard deletes the file, and the
// very next message must go through. A cache would make "unmute" mean "unmute,
// eventually".

import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BlockConfig {
  /**
   * ON by default, like `handback` and unlike `firstReply`. There is nothing
   * for a client to write: a bot whose prompt never emits the marker never
   * blocks anybody, and a peer with no block file costs one `readFile` that
   * fails with ENOENT. It must default on because the dashboard's manual Block
   * button writes the same file for every client, not only the ones whose
   * prompt carries the rule.
   */
  enabled: boolean;
  /** The token the agent emits to block the peer it is talking to. */
  marker: string;
  /** Where the per-peer block files live. Defaults to <openclaw home>/blocked. */
  stateDir: string;
  /** Keep at most this many dropped messages per peer in the `.jsonl`. 0 = never log. */
  logMax: number;
}

export const BLOCK_DEFAULTS: BlockConfig = {
  enabled: true,
  marker: "PINKLIME_BLOCK",
  stateDir: "",
  logMax: 200,
};

function defaultStateDir(): string {
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "blocked");
}

function num(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Read `channels.whatsapp-cloud.block`, falling back to the defaults above. */
export function resolveBlock(raw: any): BlockConfig {
  const r = raw ?? {};
  const d = BLOCK_DEFAULTS;
  const marker = typeof r.marker === "string" && r.marker.trim() ? r.marker.trim() : d.marker;
  return {
    enabled: r.enabled ?? d.enabled,
    marker,
    stateDir: typeof r.stateDir === "string" && r.stateDir ? r.stateDir : defaultStateDir(),
    logMax: num(r.logMax, d.logMax),
  };
}

// ---------------------------------------------------------------------------
// Finding the marker in a reply
// ---------------------------------------------------------------------------

export interface MarkerHit {
  /** True when the reply carries the marker anywhere in it. */
  found: boolean;
  /** The `:reason` suffix the agent chose, lower-cased, or null. */
  reason: string | null;
}

const NOT_FOUND: MarkerHit = { found: false, reason: null };

/** Regex-escape a configured marker so a client cannot break the matcher. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look for the marker ANYWHERE in a reply.
 *
 * Deliberately not an exact-match rule, which is the opposite of how
 * `first-reply.ts` matches an opener — and for the opposite reason. There the
 * input is the customer's and a near miss must reach the model; here the input
 * is our own agent's, the instruction is "answer with the marker and nothing
 * else", and the failure that matters is a model that obeys almost: it writes
 * the marker with a stray space, a full stop, or one polite sentence in front
 * of it. Every one of those must still block, and the customer must still see
 * none of it.
 *
 * `PINKLIME_BLOCK:abusive` carries the agent's reason. An unknown or absent
 * reason is not an error — the block is what matters, the label is a hint for
 * the operator reading the dashboard.
 */
export function findBlockMarker(text: string, marker: string): MarkerHit {
  const body = String(text ?? "");
  if (!body) return NOT_FOUND;
  const re = new RegExp(`${escapeRe(marker)}(?::([A-Za-z0-9_-]{1,32}))?`);
  const m = re.exec(body);
  if (!m) return NOT_FOUND;
  return { found: true, reason: m[1] ? m[1].toLowerCase() : null };
}

/**
 * True when ANY text in a dispatcher payload carries the marker.
 *
 * The runtime hands the channel one payload per block of the reply, and
 * `humanRhythm` then splits a single payload's text into several WhatsApp
 * messages on blank lines. Both of those are ways for a marked reply to arrive
 * in pieces, so the decision is taken on the WHOLE payload before anything is
 * split, and the caller keeps the verdict for the rest of the turn.
 */
export function payloadHasMarker(payload: any, marker: string): MarkerHit {
  const texts: unknown[] = [payload?.text, payload?.body, payload?.caption];
  for (const t of texts) {
    if (typeof t !== "string") continue;
    const hit = findBlockMarker(t, marker);
    if (hit.found) return hit;
  }
  return NOT_FOUND;
}

// ---------------------------------------------------------------------------
// State — one small JSON file per peer, on the client volume
// ---------------------------------------------------------------------------

export interface BlockEntry {
  peer: string;
  /** The agent's `:reason`, an operator's free text, or null. */
  reason: string | null;
  /** Who decided: the bot's marker, or a person in the dashboard. */
  source: "bot" | "operator";
  blockedAt: string;
  /** The operator's email, or the bot's persona/agent id. */
  blockedBy: string | null;
  /** The customer message that earned the block, for the operator to read. */
  triggerText: string | null;
  /** The OpenClaw session the block was decided in, so sync can pair the two. */
  sessionKey: string | null;
}

/** A peer id is digits, but never trust it into a path. */
export function blockFileName(peer: string): string {
  const safe = String(peer).replace(/[^0-9A-Za-z_+-]/g, "_").slice(0, 64);
  return `${safe || "unknown"}.json`;
}

/** The companion log of everything dropped while the block stands. */
export function blockLogName(peer: string): string {
  return blockFileName(peer).replace(/\.json$/, ".jsonl");
}

/**
 * The peer's block, or null.
 *
 * Called on EVERY inbound message, so a missing file must be cheap and silent.
 * An unreadable or half-written file also returns null: failing OPEN here only
 * costs one model turn, while failing closed on a corrupt file would silence a
 * real customer with nothing in the log to explain it.
 */
export async function readBlock(cfg: BlockConfig, peer: string): Promise<BlockEntry | null> {
  try {
    const text = await readFile(join(cfg.stateDir, blockFileName(peer)), "utf-8");
    const parsed = JSON.parse(text) as BlockEntry;
    return parsed && typeof parsed === "object" && parsed.peer ? parsed : null;
  } catch {
    return null; // absent or unreadable — the peer is not blocked
  }
}

/** Write atomically: a half-written block file is a peer who is neither in nor out. */
export async function writeBlock(cfg: BlockConfig, entry: BlockEntry): Promise<void> {
  await mkdir(cfg.stateDir, { recursive: true });
  const target = join(cfg.stateDir, blockFileName(entry.peer));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
  await rename(tmp, target);
}

/**
 * Lift a peer's block. Returns true when a file was actually removed.
 *
 * The `.jsonl` is left behind on purpose: it is the record of what the number
 * sent while it was blocked, and an unmute is not a reason to lose it.
 */
export async function clearBlock(cfg: BlockConfig, peer: string): Promise<boolean> {
  try {
    await unlink(join(cfg.stateDir, blockFileName(peer)));
    return true;
  } catch {
    return false; // not blocked — nothing to clear
  }
}

// ---------------------------------------------------------------------------
// The dropped-message log
// ---------------------------------------------------------------------------

export interface BlockedMessage {
  ts: string;
  waMessageId: string;
  type: string;
  text: string;
  senderName: string | null;
}

/**
 * Append one dropped message to the peer's log.
 *
 * Append-only and best effort: a log failure must never turn into a message
 * that reaches the model, which is the one thing the block exists to prevent.
 * The cap stops a determined troll from filling the volume — past it the block
 * still holds, only the record stops growing.
 */
export async function appendBlockedMessage(
  cfg: BlockConfig,
  peer: string,
  msg: BlockedMessage
): Promise<void> {
  if (cfg.logMax <= 0) return;
  const path = join(cfg.stateDir, blockLogName(peer));
  try {
    const existing = await readFile(path, "utf-8").catch(() => "");
    const lines = existing ? existing.split("\n").filter((l) => l.trim()).length : 0;
    if (lines >= cfg.logMax) return;
    await mkdir(cfg.stateDir, { recursive: true });
    await appendFile(path, `${JSON.stringify(msg)}\n`, "utf-8");
  } catch {
    // best effort — the drop already happened, which is what matters
  }
}

/** Mask a peer for the log: keep the country prefix and the last two digits. */
export function maskPeer(peer: string): string {
  const s = String(peer);
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}${"*".repeat(Math.max(0, s.length - 6))}${s.slice(-2)}`;
}
