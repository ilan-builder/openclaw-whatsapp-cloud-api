// WhatsApp (and most messengers) pick each line's base direction from the first
// strong character. A Latin name at the start of a Hebrew line ("Ilan, יש…")
// flips the whole line to LTR; a Latin run at the end ("…, Ilan") visually
// jumps to the wrong edge. Prefixing a Hebrew line with RLM (U+200F) forces
// RTL, and an RLM after a Latin run that sits on a line boundary keeps the
// name in place.
//
// Apply this only to the wire body of a plain-text send, never to templates,
// button payloads, or storage/search text. stripRtlMarks() is the inverse for
// logs and the dashboard. Keep this file in sync with
// packages/core/src/whatsapp-rtl.mjs in the lemonaid monorepo.

export const RLM = "\u200F";

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_RE = /[A-Za-z]/;
// URLs and phone numbers must not be split or given a trailing RLM — WhatsApp
// might swallow the mark into the autolink.
const PROTECTED_RE = /https?:\/\/[^\s<>]+|www\.[^\s<>]+|mailto:[^\s<>]+|\+?\d[\d\s().-]{6,}\d/gi;

export function stripRtlMarks(text: unknown): string {
  return String(text ?? "").replace(/\u200F/g, "");
}

export type RtlOptions = { locale?: string | null };

/**
 * True when the message should be sent as RTL: it contains Hebrew and either
 * Hebrew letters are at least as many as Latin, or the tenant locale is `he`.
 * A pure-English message is never marked, even for a Hebrew tenant.
 */
export function isPredominantlyHebrew(text: unknown, { locale }: RtlOptions = {}): boolean {
  // URLs and phone numbers are Latin by necessity; they must not outweigh
  // the Hebrew prose they sit next to (a booking link under a Hebrew line).
  const s = String(text ?? "").replace(PROTECTED_RE, " ");
  let he = 0;
  let la = 0;
  for (const ch of s) {
    if (HEBREW_RE.test(ch)) he++;
    else if (LATIN_RE.test(ch)) la++;
  }
  if (he === 0) return false;
  if (he >= la) return true;
  const lang = String(locale ?? "").trim().toLowerCase();
  return lang === "he" || lang === "iw";
}

function maskProtected(line: string): { masked: string; slots: string[] } {
  const slots: string[] = [];
  const masked = line.replace(PROTECTED_RE, (m) => {
    const i = slots.length;
    slots.push(m);
    return `\u0000${i}\u0000`;
  });
  return { masked, slots };
}

function unmask(s: string, slots: string[]): string {
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? "");
}

const TRAILING_LATIN_RE = /[A-Za-z][A-Za-z'’\-]*[,.:;!?]*\s*$/;
const TRAILING_PLACEHOLDER_RE = /\u0000\d+\u0000\W*$/;

function ensureRtlLine(line: string): string {
  if (!line || !HEBREW_RE.test(line)) return line;
  const { masked, slots } = maskProtected(line);
  let s = masked.replace(/^\u200F+/, "").replace(/\u200F+$/, "");
  s = s.replace(/^(\s*[A-Za-z][A-Za-z'’\-]*[,.:;!?]*)\u200F+/, "$1");

  let out = RLM + s;
  const lead = out.match(/^(\u200F)(\s*)([A-Za-z][A-Za-z'’\-]*[,.:;!?]*)/);
  if (lead) {
    out = `${lead[1]}${lead[2]}${lead[3]}${RLM}${out.slice(lead[0].length)}`;
  }
  if (TRAILING_LATIN_RE.test(out) && !TRAILING_PLACEHOLDER_RE.test(out) && !/\u200F\s*$/.test(out)) {
    out = out.replace(/\s*$/, "") + RLM;
  }
  return unmask(out, slots);
}

/**
 * Force RTL rendering on each Hebrew line of a WhatsApp text body.
 * Idempotent. Leaves pure-English text, URL-only lines, phone numbers,
 * and templates (do not call this on them) alone.
 */
export function ensureWhatsAppRtl(text: string, opts: RtlOptions = {}): string {
  if (typeof text !== "string" || text === "") return text;
  if (!isPredominantlyHebrew(text, opts)) return text;
  return text.split("\n").map((line) => {
    const cr = line.endsWith("\r");
    const core = cr ? line.slice(0, -1) : line;
    const fixed = ensureRtlLine(core);
    return cr ? `${fixed}\r` : fixed;
  }).join("\n");
}
