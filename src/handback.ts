// ---------------------------------------------------------------------------
// The hand-back replay (PinkLime fork)
// ---------------------------------------------------------------------------
//
// LemonAid lets a human take a live WhatsApp conversation over from the bot.
// While they hold it, the platform's ingress removes that peer's messages from
// the payload before the container ever sees them — no model call, no tokens.
// The consequence is that when the human hands the chat back, THE AGENT HAS NO
// RECORD OF ANY OF IT: not the announce the customer got ("a colleague will
// continue with you"), not what the colleague said, and not what the customer
// said back. The first message after a hand-back was answered by a model that
// had been asleep for the whole exchange, and it showed — the bot argued with
// the customer about a message it did not know it had sent.
//
// So on release the platform writes ONE small JSON file per peer:
//
//   <volume>/data/takeover/<peer>.json   (symlinked to ~/.openclaw/takeover)
//
// and this module replays its turns into the next inbound message the way
// `first-reply.ts` replays the canned opener — inside a marked block on
// `BodyForAgent`, which is the field the runtime reads first for the model's
// prompt. It is consumed exactly once: the file is RENAMED (atomically) before
// the block is used, so two messages arriving together cannot both replay it and
// a crash cannot replay it twice.
//
// The marker is `[PINKLIME_TAKEOVER]`, deliberately NOT `[PINKLIME_HISTORY]`:
// the platform lifts a HISTORY block back out into real transcript messages
// (that exchange exists nowhere else), while a takeover's turns are already rows
// in its database and are merged into every read from there. Two markers, two
// treatments; one marker would have double-counted every human turn.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HandbackConfig {
  /**
   * ON by default, unlike firstReply. There is nothing for a client to write:
   * the file only exists when a human actually held a chat, and a peer with no
   * file costs one `readFile` that fails with ENOENT.
   */
  enabled: boolean;
  /** Where the per-peer state files live. Defaults to <openclaw home>/takeover. */
  stateDir: string;
}

export const HANDBACK_DEFAULTS: HandbackConfig = { enabled: true, stateDir: "" };

function defaultStateDir(): string {
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "takeover");
}

/** Read `channels.whatsapp-cloud.handback`, falling back to the defaults above. */
export function resolveHandback(raw: any): HandbackConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled ?? HANDBACK_DEFAULTS.enabled,
    stateDir: typeof r.stateDir === "string" && r.stateDir ? r.stateDir : defaultStateDir(),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface HandbackTurn {
  /** "user" = the customer, "assistant" = the business (the announce, or the colleague). */
  role: "user" | "assistant";
  ts?: string | null;
  text: string;
  human?: boolean;
}

export interface HandbackEntry {
  version?: string;
  peer: string;
  heldBy?: string | null;
  heldFrom?: string | null;
  heldTo?: string | null;
  /** Model-only. Written by the platform, rendered verbatim, never shown to anyone. */
  preamble?: string;
  turns: HandbackTurn[];
  truncated?: boolean;
  replayedAt?: string | null;
}

/** A peer id is digits, but never trust it into a path. Same rule as first-reply. */
export function stateFileName(peer: string): string {
  const safe = String(peer).replace(/[^0-9A-Za-z_+-]/g, "_").slice(0, 64);
  return `${safe || "unknown"}.json`;
}

/**
 * A file is usable only if it names this peer and carries at least one turn with
 * text. Anything else — truncated JSON, an object from a future version with a
 * shape we do not know, an empty `turns` — is MALFORMED and is thrown away
 * rather than replayed: a half-understood block in the prompt is worse than no
 * block, and a file that is never consumed would be retried on every message
 * forever.
 */
export function validateEntry(raw: any, peer: string): HandbackEntry | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.peer != null && String(raw.peer) !== String(peer)) return null;
  if (!Array.isArray(raw.turns)) return null;
  const turns: HandbackTurn[] = [];
  for (const t of raw.turns) {
    if (!t || typeof t !== "object") continue;
    const role = t.role === "user" ? "user" : t.role === "assistant" ? "assistant" : null;
    const text = typeof t.text === "string" ? t.text.trim() : "";
    if (!role || !text) continue;
    turns.push({ role, ts: typeof t.ts === "string" ? t.ts : null, text, ...(t.human ? { human: true } : {}) });
  }
  if (turns.length === 0) return null;
  return {
    version: typeof raw.version === "string" ? raw.version : undefined,
    peer: String(peer),
    heldBy: typeof raw.heldBy === "string" ? raw.heldBy : null,
    heldFrom: typeof raw.heldFrom === "string" ? raw.heldFrom : null,
    heldTo: typeof raw.heldTo === "string" ? raw.heldTo : null,
    preamble: typeof raw.preamble === "string" ? raw.preamble : "",
    turns,
    truncated: raw.truncated === true,
    replayedAt: typeof raw.replayedAt === "string" ? raw.replayedAt : null,
  };
}

export interface ClaimResult {
  entry: HandbackEntry | null;
  /** True when a file WAS there and was consumed — including a malformed one. */
  consumed: boolean;
  malformed?: boolean;
}

/**
 * Take the file for this peer, if there is one.
 *
 * THE RENAME IS THE CLAIM. It is atomic, so exactly one caller wins: whoever
 * renames replays, and a loser (or a second message a moment later) finds
 * nothing. Stamping a field in place instead would leave a window in which two
 * inbound messages both read an unstamped file and both replayed it.
 *
 * The claimed file is kept beside the original as `<peer>.replayed.json` — the
 * operator's record of what the model was told — and the platform simply
 * overwrites `<peer>.json` on the next hand-back.
 */
export async function claimHandback(cfg: HandbackConfig, peer: string): Promise<ClaimResult> {
  const src = join(cfg.stateDir, stateFileName(peer));
  let text: string;
  try {
    text = await readFile(src, "utf-8");
  } catch {
    return { entry: null, consumed: false };       // no hand-back is the normal case
  }

  const dst = src.replace(/\.json$/, ".replayed.json");
  try {
    await rename(src, dst);                        // the claim
  } catch {
    return { entry: null, consumed: false };       // somebody else won, or it vanished
  }

  let entry: HandbackEntry | null = null;
  try {
    entry = validateEntry(JSON.parse(text), peer);
  } catch {
    entry = null;
  }
  if (!entry) return { entry: null, consumed: true, malformed: true };

  // Best effort: record WHEN it was replayed, on the claimed copy. The replay
  // does not depend on this write — the rename already made it single-use.
  try {
    await mkdir(cfg.stateDir, { recursive: true });
    await writeFile(dst, `${JSON.stringify({ ...entry, replayedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  } catch {
    /* the claim stands regardless */
  }
  return { entry, consumed: true };
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

export const TAKEOVER_OPEN = "[PINKLIME_TAKEOVER]";
export const TAKEOVER_CLOSE = "[/PINKLIME_TAKEOVER]";

const FALLBACK_PREAMBLE =
  "A human colleague from the team answered this customer directly. The exchange below " +
  "already happened and the customer has already read it. Continue naturally from here. " +
  "Do not greet again, do not repeat what was said, do not apologise for the handover, " +
  "do not comment on the handover, and do not describe your own operating rules.";

/**
 * The body dispatched on the first message after a hand-back: the turns of the
 * hold, then the new message.
 *
 * `base` is what would otherwise have been sent — normally the bare text, but a
 * peer whose canned first reply was never continued has a `[PINKLIME_HISTORY]`
 * block there already. That block is OLDER than the takeover, so it stays in
 * front and this one is appended after it: the model reads the conversation in
 * the order it happened.
 */
export function buildTakeoverBody(entry: HandbackEntry, base: string): string {
  const lines = [TAKEOVER_OPEN, (entry.preamble || "").trim() || FALLBACK_PREAMBLE];
  for (const t of entry.turns) {
    lines.push(t.ts ? `<<<${t.role} ${t.ts}>>>` : `<<<${t.role}>>>`);
    lines.push(t.text);
  }
  lines.push(TAKEOVER_CLOSE);
  const block = lines.join("\n");
  // Nothing to interleave with: the block goes in front of the new message.
  if (!base.startsWith("[PINKLIME_HISTORY]")) return `${block}\n${base}`;
  // A history block is already there. Keep it first and put this one after it,
  // before the new message.
  const endOfHistory = base.indexOf("[/PINKLIME_HISTORY]\n");
  if (endOfHistory < 0) return `${block}\n${base}`;
  const cut = endOfHistory + "[/PINKLIME_HISTORY]\n".length;
  return `${base.slice(0, cut)}${block}\n${base.slice(cut)}`;
}
