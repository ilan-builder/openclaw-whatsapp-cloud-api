// ---------------------------------------------------------------------------
// Human reply rhythm (PinkLime fork)
// ---------------------------------------------------------------------------
//
// A bot that answers in three seconds reads as a bot, whatever it writes. This
// module paces outbound replies so the customer sees the rhythm of a person who
// read the message, thought, and typed:
//
//   read receipt (immediate)  ->  typing after a pause  ->  reply after minMs..maxMs
//
// The wait is a TARGET TOTAL, not an added delay: model generation happens while
// we wait, so a reply that took 4s to generate waits the remaining time only, and
// a reply that took 20s is sent as soon as it is ready.
//
// It also splits a reply written as two paragraphs into two WhatsApp messages
// with a short gap, which is how a person actually texts.
//
// Everything here is OFF unless the channel config asks for it.

import type { Logger, WhatsAppCloudConfig } from "./types.js";
import { sendTypingIndicator } from "./api.js";

export interface HumanRhythmConfig {
  /** Master switch. Off by default: an unconfigured client behaves exactly as before. */
  enabled: boolean;
  /** Lower bound of the target time from inbound message to first outbound message. */
  minMs: number;
  /** Upper bound of that target. A value is drawn per message, so no two waits match. */
  maxMs: number;
  /** How long to wait before the typing indicator appears (a person reads first). */
  typingAfterMs: number;
  /** Split a reply on blank lines into separate WhatsApp messages. */
  splitParagraphs: boolean;
  /** Never send more than this many messages for one reply. */
  maxParts: number;
  /** Gap between those messages, lower bound. */
  partGapMinMs: number;
  /** Gap between those messages, upper bound. */
  partGapMaxMs: number;
  /** A paragraph longer than this is a long answer, not a texting rhythm: never split. */
  maxPartChars: number;
}

export const HUMAN_RHYTHM_DEFAULTS: HumanRhythmConfig = {
  enabled: false,
  minMs: 8000,
  maxMs: 15000,
  typingAfterMs: 2500,
  splitParagraphs: true,
  maxParts: 3,
  partGapMinMs: 2500,
  partGapMaxMs: 5000,
  maxPartChars: 400,
};

/** Meta drops the typing indicator after 25s, so refresh it while we wait. */
const TYPING_REFRESH_MS = 20000;

function num(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Read `channels.whatsapp-cloud.humanRhythm`, falling back to the defaults above. */
export function resolveHumanRhythm(raw: any): HumanRhythmConfig {
  const r = raw ?? {};
  const d = HUMAN_RHYTHM_DEFAULTS;
  const minMs = num(r.minMs, d.minMs);
  const maxMs = Math.max(minMs, num(r.maxMs, Math.max(minMs, d.maxMs)));
  const partGapMinMs = num(r.partGapMinMs, d.partGapMinMs);
  const partGapMaxMs = Math.max(partGapMinMs, num(r.partGapMaxMs, Math.max(partGapMinMs, d.partGapMaxMs)));
  return {
    enabled: r.enabled ?? d.enabled,
    minMs,
    maxMs,
    typingAfterMs: num(r.typingAfterMs, d.typingAfterMs),
    splitParagraphs: r.splitParagraphs ?? d.splitParagraphs,
    maxParts: Math.max(1, num(r.maxParts, d.maxParts, 1)),
    partGapMinMs,
    partGapMaxMs,
    maxPartChars: Math.max(1, num(r.maxPartChars, d.maxPartChars, 1)),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function between(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/**
 * Split a reply into the messages a person would actually send.
 *
 * Blank lines are the boundary, because that is what a model produces when it
 * writes two beats. Single newlines stay inside one message: a three-line reply
 * is one message, exactly as today. A long paragraph is never split, and the
 * tail is merged so the reply never exceeds `maxParts` messages.
 */
export function splitIntoParts(text: string, rhythm: HumanRhythmConfig): string[] {
  if (!rhythm.splitParagraphs) return [text];
  const parts = text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return [text];
  if (parts.some((p) => p.length > rhythm.maxPartChars)) return [text];
  if (parts.length <= rhythm.maxParts) return parts;
  const head = parts.slice(0, rhythm.maxParts - 1);
  head.push(parts.slice(rhythm.maxParts - 1).join("\n\n"));
  return head;
}

export interface ReplyPacer {
  /** Await before sending the next outbound message of this turn. */
  beforeSend(): Promise<void>;
  /** Stop the typing keepalive. Always call it, in a finally block. */
  stop(): void;
}

/**
 * Paces one inbound message's reply. Created when the message arrives, so the
 * clock starts at the same moment the customer pressed send.
 */
export function createReplyPacer(params: {
  config: WhatsAppCloudConfig;
  rhythm: HumanRhythmConfig;
  messageId: string;
  log: Logger;
}): ReplyPacer {
  const { config, rhythm, messageId, log } = params;
  const startedAt = Date.now();
  const target = between(rhythm.minMs, rhythm.maxMs);
  let sent = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const showTyping = () => {
    if (stopped) return;
    sendTypingIndicator(config, messageId, log).catch(() => {});
    timer = setTimeout(showTyping, TYPING_REFRESH_MS);
  };
  timer = setTimeout(showTyping, rhythm.typingAfterMs);

  return {
    async beforeSend() {
      if (sent === 0) {
        const remaining = target - (Date.now() - startedAt);
        if (remaining > 0) await sleep(remaining);
      } else {
        await sleep(between(rhythm.partGapMinMs, rhythm.partGapMaxMs));
      }
      sent += 1;
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
