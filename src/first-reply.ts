// ---------------------------------------------------------------------------
// Canned first reply (PinkLime fork)
// ---------------------------------------------------------------------------
//
// A click-to-WhatsApp ad delivers the SAME pre-filled opener over and over
// ("היי, אשמח לקבל פרטים"). Answering it with the model costs a full cold
// prompt, and more than a quarter of those conversations stop right there. So
// the first message gets a canned, model-free answer, and the model is called
// only from the customer's SECOND message — with the two earlier messages
// replayed into the prompt, so the agent continues instead of starting over.
//
// Everything here is OFF unless the channel config asks for it.
//
// The matching rule is EXACT (after whitespace normalisation), never a prefix
// and never "contains": the same ad prefill also arrives with a real question
// appended to it, and those must reach the model.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FirstReplyConfig {
  /** Master switch. Off by default: an unconfigured client behaves exactly as before. */
  enabled: boolean;
  /** Openers answered without the model. EXACT match after whitespace normalisation. */
  match: string[];
  /** The canned reply. `{name}` = the visitor's first name, `{name_comma}` = " <name>," or ",". */
  text: string;
  /** Used instead of `text` when no usable first name was found. Falls back to `text`. */
  textNoName: string;
  /** A peer whose last canned reply is older than this is treated as brand new again. */
  cooldownDays: number;
  /** Where the per-peer state files live. Defaults to <openclaw home>/first-reply. */
  stateDir: string;
  /**
   * The line that opens the replayed history block. It is inside the block, so
   * the model reads it and the dashboard never shows it.
   */
  historyPreamble: string;
}

export const FIRST_REPLY_DEFAULTS: FirstReplyConfig = {
  enabled: false,
  match: [],
  text: "",
  textNoName: "",
  cooldownDays: 30,
  stateDir: "",
  historyPreamble:
    "These are the earlier messages of THIS conversation. The customer has already " +
    "received your reply below. Do not greet again and do not introduce yourself " +
    "again — continue the conversation from here.",
};

function defaultStateDir(): string {
  const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
  return join(home, "first-reply");
}

function num(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
}

/** Read `channels.whatsapp-cloud.firstReply`, falling back to the defaults above. */
export function resolveFirstReply(raw: any): FirstReplyConfig {
  const r = raw ?? {};
  const d = FIRST_REPLY_DEFAULTS;
  const text = typeof r.text === "string" ? r.text : d.text;
  return {
    enabled: r.enabled ?? d.enabled,
    match: strList(r.match),
    text,
    textNoName: typeof r.textNoName === "string" && r.textNoName ? r.textNoName : text,
    cooldownDays: num(r.cooldownDays, d.cooldownDays),
    stateDir: typeof r.stateDir === "string" && r.stateDir ? r.stateDir : defaultStateDir(),
    historyPreamble:
      typeof r.historyPreamble === "string" && r.historyPreamble
        ? r.historyPreamble
        : d.historyPreamble,
  };
}

/** Any text this config could actually send, ignoring whitespace-only strings. */
export function firstReplyHasText(cfg: FirstReplyConfig): boolean {
  return cfg.text.trim().length > 0 || cfg.textNoName.trim().length > 0;
}

/**
 * A config that is switched on and actually has something to match and something
 * to say.
 *
 * Since the base layer ships `enabled: true`, a client that never wrote its own
 * texts resolves to "on, but with nothing to say". That must behave EXACTLY like
 * off — never an empty WhatsApp message — so the emptiness is checked here and
 * reported once at startup by `firstReplyStatus()`.
 */
export function firstReplyUsable(cfg: FirstReplyConfig): boolean {
  return cfg.enabled && cfg.match.length > 0 && firstReplyHasText(cfg);
}

/**
 * The ONE line the channel logs at startup, so an operator can tell a bot that
 * answers the ad opener from one that only thinks it does.
 */
export function firstReplyStatus(cfg: FirstReplyConfig): { active: boolean; line: string } {
  if (!cfg.enabled) return { active: false, line: "[first-reply] disabled" };
  if (!firstReplyHasText(cfg)) {
    return { active: false, line: "[first-reply] enabled but no text configured; inactive" };
  }
  if (cfg.match.length === 0) {
    return { active: false, line: "[first-reply] enabled but no match openers configured; inactive" };
  }
  return {
    active: true,
    line: `[first-reply] ACTIVE — ${cfg.match.length} opener(s), cooldown ${cfg.cooldownDays}d`,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Invisible characters a phone keyboard and an RTL ad prefill both add: NBSP,
// the bidi marks, and the isolate controls. They must not decide a match.
const INVISIBLE_RE = /[\u00A0\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Collapse a message to the form the match list is compared against. */
export function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index of the matching opener, or -1.
 *
 * EXACT equality only. "היי, אשמח לקבל פרטיםIs this kosher?" is the same ad
 * prefill with a real question glued to it — that is a customer who asked
 * something, and it must reach the model.
 */
export function matchIndex(text: string, patterns: string[]): number {
  const needle = normalizeForMatch(text);
  if (!needle) return -1;
  for (let i = 0; i < patterns.length; i++) {
    if (normalizeForMatch(patterns[i]) === needle) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The visitor's name
// ---------------------------------------------------------------------------

// A WhatsApp profile name is whatever the visitor typed: a first name, a full
// name, a business, an emoji, or (when there is no profile at all) their own
// phone number. Only something that reads like a first name is safe to greet
// with, so anything else yields null and the no-name text is used instead.
const NAME_TOKEN_RE = /^[\p{L}][\p{L}'’-]{1,15}$/u;

export function firstName(senderName?: string | null): string | null {
  const raw = normalizeForMatch(senderName ?? "");
  if (!raw) return null;
  const tokens = raw.split(" ");
  if (tokens.length > 2) return null; // a sentence or a business name, not a name
  const first = tokens[0];
  if (!NAME_TOKEN_RE.test(first)) return null;
  return first;
}

/** `{name}` → the first name (or ""), `{name_comma}` → " <name>," or ",". */
export function renderFirstReply(cfg: FirstReplyConfig, name: string | null): string {
  // Either text may be missing or whitespace-only; the other one then answers.
  // An empty render is never sent — the caller falls through to the model.
  const withName = cfg.text.trim() ? cfg.text : cfg.textNoName;
  const withoutName = cfg.textNoName.trim() ? cfg.textNoName : cfg.text;
  const template = name ? withName : withoutName;
  return template
    .replace(/\{name_comma\}/g, name ? ` ${name},` : ",")
    .replace(/\{name\}/g, name ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// State — one small JSON file per peer, on the client volume
// ---------------------------------------------------------------------------

export interface FirstReplyReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

export interface FirstReplyEntry {
  peer: string;
  senderName: string | null;
  inbound: { text: string; ts: string; waMessageId: string; referral?: FirstReplyReferral };
  reply: { text: string; ts: string; waMessageId?: string };
  /** ISO timestamp of the message that woke the model, or null while nobody came back. */
  continuedAt: string | null;
  /** The OpenClaw session this peer's conversation will use, so sync can pair the two. */
  sessionKey: string;
}

/** A peer id is digits, but never trust it into a path. */
export function stateFileName(peer: string): string {
  const safe = String(peer).replace(/[^0-9A-Za-z_+-]/g, "_").slice(0, 64);
  return `${safe || "unknown"}.json`;
}

export async function readEntry(
  cfg: FirstReplyConfig,
  peer: string
): Promise<FirstReplyEntry | null> {
  try {
    const text = await readFile(join(cfg.stateDir, stateFileName(peer)), "utf-8");
    const parsed = JSON.parse(text) as FirstReplyEntry;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // absent or unreadable — treat the peer as brand new
  }
}

/** Write atomically: a half-written state file would re-canned-reply a live chat. */
export async function writeEntry(cfg: FirstReplyConfig, entry: FirstReplyEntry): Promise<void> {
  await mkdir(cfg.stateDir, { recursive: true });
  const target = join(cfg.stateDir, stateFileName(entry.peer));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
  await rename(tmp, target);
}

/**
 * Delete a peer's state, so the next matching opener is answered with the canned
 * reply again. Returns true when a file was actually removed.
 */
export async function clearEntry(cfg: FirstReplyConfig, peer: string): Promise<boolean> {
  try {
    await unlink(join(cfg.stateDir, stateFileName(peer)));
    return true;
  } catch {
    return false; // absent already — nothing to clear
  }
}

// ---------------------------------------------------------------------------
// A session reset makes the peer new again
// ---------------------------------------------------------------------------
//
// `/new` means "start this conversation over", and the canned greeting is part
// of the start. Without this the operator resets the session and the very next
// "שלום" still goes to the model, which is what made the greeting impossible to
// test on your own number inside the cooldown.

const RESET_COMMANDS = new Set(["new", "reset"]);

/** True for `/new` and `/reset` — the commands that clear the agent's session. */
export function isSessionResetCommand(text: string): boolean {
  const first = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first.startsWith("/")) return false;
  return RESET_COMMANDS.has(first.slice(1).toLowerCase());
}

/**
 * True when this peer may actually run commands, per `commands.allowFrom` on the
 * loaded config — the same list the runtime authorizes with. The cooldown must
 * reset only when the reset really happened, so a customer who types "/new" at a
 * bot that ignores them is not greeted from scratch mid-conversation.
 *
 * An absent or empty list mirrors "not restricted here" and allows it.
 */
export function commandsAllowedFrom(cfg: any, peer: string, channel = "whatsapp-cloud"): boolean {
  const raw = cfg?.commands?.allowFrom;
  const list: unknown = Array.isArray(raw) ? raw : raw?.[channel];
  if (!Array.isArray(list) || list.length === 0) return true;
  const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
  const want = digits(peer);
  return want.length > 0 && list.some((entry) => digits(entry) === want);
}

/** True when the entry is old enough that the peer counts as a new visitor again. */
export function isExpired(entry: FirstReplyEntry, cooldownDays: number, now = Date.now()): boolean {
  if (cooldownDays <= 0) return false;
  const stamp = Date.parse(entry.continuedAt || entry.reply?.ts || entry.inbound?.ts || "");
  if (!Number.isFinite(stamp)) return true;
  return now - stamp > cooldownDays * 86400_000;
}

// ---------------------------------------------------------------------------
// Replaying the two messages into the model's first real turn
// ---------------------------------------------------------------------------

export const HISTORY_OPEN = "[PINKLIME_HISTORY]";
export const HISTORY_CLOSE = "[/PINKLIME_HISTORY]";

/**
 * The body dispatched on the customer's SECOND message: the canned exchange,
 * then the new message.
 *
 * The block is machine-readable on purpose — `parseTranscriptJsonl` in
 * @lemonaid/core lifts the two entries out of it and stores them as real
 * transcript messages, so the dashboard shows the conversation's true shape
 * instead of one message with a wall of text inside it.
 */
export function buildHistoryBody(
  entry: FirstReplyEntry,
  newText: string,
  preamble: string
): string {
  const lines = [
    HISTORY_OPEN,
    preamble,
    `<<<user ${entry.inbound.ts}>>>`,
    entry.inbound.text,
    `<<<assistant ${entry.reply.ts}>>>`,
    entry.reply.text,
    HISTORY_CLOSE,
  ];
  return `${lines.join("\n")}\n${newText}`;
}

/** Mask a peer for the log: keep the country prefix and the last two digits. */
export function maskPeer(peer: string): string {
  const s = String(peer);
  if (s.length <= 6) return s;
  return `${s.slice(0, 4)}${"*".repeat(Math.max(0, s.length - 6))}${s.slice(-2)}`;
}
