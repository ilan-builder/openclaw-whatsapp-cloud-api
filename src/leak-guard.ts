/**
 * Reply leak guard (PinkLime fork) — the LAST gate before Meta.
 *
 * 2026-11-05, solar-israel on OpenClaw 2026.10.10: grok sometimes wrote the
 * ARGUMENTS of a tool call as its reply text instead of making the call
 * (stopReason=stop), e.g.
 *   {"path": "/tmp/lead-payload.json", "content": "{\n \"_wa_from\": …}"}
 *   {"command": "bash ~/.openclaw/workspace/skills/lead-capture/submit-lead.sh /tmp/lead-payload.json", …}
 * The runtime treated that text as the final reply and this channel delivered
 * it. Three such messages reached a customer.
 *
 * Rule (Ilan, 2026-11-05): text like that must be IMPOSSIBLE to send. So:
 *
 *   1. classifyOutboundText() is deliberately strict and FAIL-CLOSED. A real
 *      customer reply is prose: Hebrew/English sentences, emoji, a URL. It never
 *      has braces, backslashes, code fences, JSON keys, shell commands or
 *      internal paths. Anything that does is withheld, and any exception while
 *      classifying counts as a leak.
 *   2. outboundBodyVerdict() runs inside sendRequest() (api.ts) on EVERY body
 *      bound for /messages — agent replies, outbound-adapter sends, canned
 *      replies, media captions, interactive and template text. There is no
 *      other code path that POSTs a message to Meta. An unknown message type,
 *      or a body the guard cannot read, is blocked too.
 *   3. index.ts also checks each reply payload BEFORE it is split into
 *      WhatsApp parts, withholds the rest of that turn, re-prompts the model
 *      once, and records an alert for the watchdog (-> Pinklime-CEO) when the
 *      retry leaks again. That is a convenience on top; (2) is the guarantee.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LeakVerdict {
  leak: boolean;
  reason: string | null;
}

const OK: LeakVerdict = { leak: false, reason: null };

// Checked against the WHOLE text. Prose never matches any of these.
const STRUCTURAL_RULES: Array<[string, RegExp]> = [
  ["starts-like-json", /^\s*[\[{]/],
  ["brace", /[{}\uFF5B\uFF5D]/],          // incl. fullwidth ｛ ｝
  ["backslash", /[\\\uFF3C]/],           // incl. fullwidth ＼
  ["code-fence", /```/],
  ["json-key", /["'][A-Za-z_$][\w$.\-]{0,63}["']\s*:/],
  ["tool-markup", /<\/?\s*(tool_call|tool_use|tool_result|function_call|function_calls|function|invoke|parameter|xai:function_call)\b/i],
  ["tool-words", /\b(tool_?call|toolCall|function_call|tool_use|stopReason|tool_choice)\b/i],
  ["payload-field", /(^|[^\w])(p_[a-z]+_[a-z_]+|_wa_from|_callback_requested|lead-payload|submit-lead|submit-transcript|session_id)\b/],
  ["shebang", /^\s*#!/m],
  ["heredoc", /<<-?\s*['"]?[A-Z_]{2,}['"]?/],
];

// Checked against the text with URLs removed, so a link the agent is allowed
// to send (a Waze link, the client's contact page) never trips them.
const BARE_RULES: Array<[string, RegExp]> = [
  ["internal-path", /(~\/|\/\.openclaw|\/tmp\/|\/home\/|\/usr\/|\/app\/|\/data\/|\/etc\/|\/var\/|skills\/[\w.-]+|SKILL\.md)/i],
  ["file-extension", /\b[\w.-]+\.(sh|mjs|cjs|js|ts|json|jsonl|ya?ml|py|sqlite|db|env|md|log)\b/i],
  ["shell-command", /(^|[\s;|&`$(])(bash|sh|zsh|node|python3?|curl|wget|jq|sed|awk|grep|cat|echo|rm|mv|cp|mkdir|chmod|sudo|npm|npx|openclaw)\s+(-{1,2}[\w-]+\s+)*["']?([~\/$]|\.\.?\/)/m],
  ["shell-operator", /(\s(&&|\|\|)\s)|(\$\(|`[^`]*`)/],
];

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/**
 * True-ish verdict = do NOT send. Fail-closed: anything unexpected, including
 * a non-string or an exception, is a leak.
 */
export function classifyOutboundText(text: unknown): LeakVerdict {
  try {
    if (text === undefined || text === null) return OK; // nothing to send
    if (typeof text !== "string") return { leak: true, reason: "non-string-text" };
    if (text.trim() === "") return OK;
    for (const [reason, re] of STRUCTURAL_RULES) {
      if (re.test(text)) return { leak: true, reason };
    }
    const bare = text.replace(URL_RE, " ");
    for (const [reason, re] of BARE_RULES) {
      if (re.test(bare)) return { leak: true, reason };
    }
    return OK;
  } catch {
    return { leak: true, reason: "guard-error" };
  }
}

// Message types this channel sends. Anything else is blocked: the guard must
// not wave through a shape it has never read.
const KNOWN_TYPES = new Set(["text", "image", "audio", "video", "document", "sticker", "interactive", "template"]);

function pushStr(out: unknown[], v: unknown) {
  if (v !== undefined && v !== null) out.push(v);
}

/** Every customer-visible string in a /messages body. Throws on a shape it cannot read. */
export function customerVisibleTexts(body: Record<string, any>): unknown[] {
  const out: unknown[] = [];
  const type = body?.type;
  if (type === "text") {
    pushStr(out, body.text?.body);
    if (typeof body.text?.body !== "string") throw new Error("text body missing");
  } else if (type === "image" || type === "video" || type === "document" || type === "audio" || type === "sticker") {
    const m = body[type] ?? {};
    pushStr(out, m.caption);
    pushStr(out, m.filename);
  } else if (type === "interactive") {
    const i = body.interactive ?? {};
    pushStr(out, i.body?.text);
    pushStr(out, i.header?.text);
    pushStr(out, i.footer?.text);
    pushStr(out, i.action?.button);
    for (const b of i.action?.buttons ?? []) pushStr(out, b?.reply?.title);
    for (const s of i.action?.sections ?? []) {
      pushStr(out, s?.title);
      for (const r of s?.rows ?? []) {
        pushStr(out, r?.title);
        pushStr(out, r?.description);
      }
    }
    pushStr(out, i.action?.parameters?.flow_cta);
    pushStr(out, i.action?.parameters?.display_text);
  } else if (type === "template") {
    for (const c of body.template?.components ?? []) {
      for (const p of c?.parameters ?? []) {
        if (p?.type === "text") pushStr(out, p.text);
      }
    }
  }
  return out;
}

/** The verdict sendRequest() acts on. Fail-closed on unknown types and on errors. */
export function outboundBodyVerdict(body: Record<string, any>): LeakVerdict {
  try {
    if (!body || typeof body !== "object") return { leak: true, reason: "no-body" };
    if (!KNOWN_TYPES.has(String(body.type))) return { leak: true, reason: `unknown-type:${String(body.type)}` };
    for (const t of customerVisibleTexts(body)) {
      const v = classifyOutboundText(t);
      if (v.leak) return v;
    }
    return OK;
  } catch {
    return { leak: true, reason: "guard-error" };
  }
}

// ---------------------------------------------------------------------------
// Alerts: one JSON file per event, picked up by the host watchdog
// (workers/sync/watchdog.mjs, "reply_leak" sweep) and sent to Pinklime-CEO.
// The container has no Telegram credentials, on purpose.
// ---------------------------------------------------------------------------

export type LeakStage = "final-gate" | "turn" | "retried-ok" | "retry-failed";

export function leakAlertDir(): string {
  // /volume/data is the tenant volume (host: /data/lemonaid/<tenant>/volume/data),
  // the only place the host watchdog can read. ~/.openclaw is NOT persisted.
  if (process.env.PINKLIME_LEAK_GUARD_DIR) return process.env.PINKLIME_LEAK_GUARD_DIR;
  if (existsSync("/volume/data")) return join("/volume/data", "leak-guard", "pending");
  return join(homedir(), ".openclaw", "leak-guard", "pending");
}

const maskDigits = (s: string) => s.replace(/\+?\d[\d\s-]{7,}\d/g, (m) => {
  const d = m.replace(/\D/g, "");
  return d.length >= 9 ? `${d.slice(0, 3)}*****${d.slice(-2)}` : m;
});

export function leakSnippet(text: unknown, max = 160): string {
  const s = maskDigits(String(text ?? "")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Best effort: never throws. The block itself never depends on this write. */
export function recordLeak(
  event: { stage: LeakStage; reason: string | null; to?: string; text?: unknown; sessionKey?: string; messageId?: string },
  dir = leakAlertDir()
): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const name = `${at.replace(/[:.]/g, "-")}-${event.stage}-${randomBytes(3).toString("hex")}.json`;
    const peer = String(event.to ?? "").replace(/\D/g, "");
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        version: 1,
        at,
        stage: event.stage,
        reason: event.reason,
        peer,
        sessionKey: event.sessionKey ?? null,
        inboundMessageId: event.messageId ?? null,
        snippet: leakSnippet(event.text),
      }) + "\n",
      { mode: 0o640 }
    );
    return name;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The one re-prompt after a leaked turn
// ---------------------------------------------------------------------------

export const LEAK_RETRY_OPEN = "[PINKLIME_LEAK_RETRY]";
export const LEAK_RETRY_CLOSE = "[/PINKLIME_LEAK_RETRY]";

export function buildLeakRetryBody(reason: string | null): string {
  return [
    LEAK_RETRY_OPEN,
    "System notice from the WhatsApp channel. This is NOT a message from the customer.",
    `Your previous reply was NOT delivered: it was tool-call arguments or code written as plain text (${reason ?? "unknown"}). The customer saw nothing.`,
    "- If you meant to run a tool (write, exec, read, ...), make a REAL tool call now. Never type tool arguments, JSON, file paths or shell commands as a message.",
    "- After the tool runs, reply with only the customer-facing message, in the language of the conversation.",
    "- Do not mention this notice, tools, files, scripts or errors to the customer.",
    LEAK_RETRY_CLOSE,
  ].join("\n");
}
