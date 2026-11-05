// Reply leak guard: text that looks like a tool call, code, a command or an
// internal path must be IMPOSSIBLE to send to a customer. These tests replay
// the exact texts that reached a solar-israel customer on 2026-11-05 and
// assert that Meta's /messages endpoint (fetch) is never called for them, on
// every send path this plugin has.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhatsAppCloudConfig } from "../types.js";

const ALERT_DIR = mkdtempSync(join(tmpdir(), "leak-guard-test-"));
process.env.PINKLIME_LEAK_GUARD_DIR = ALERT_DIR;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  classifyOutboundText,
  outboundBodyVerdict,
  customerVisibleTexts,
  recordLeak,
  leakSnippet,
  buildLeakRetryBody,
  LEAK_RETRY_OPEN,
} from "../leak-guard.js";
import { sendText, sendMedia, sendInteractive, sendButtons, sendTemplate } from "../api.js";
import { _outboundForTests as outbound } from "../index.js";
import { setWhatsAppCloudRuntime } from "../runtime.js";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "leaked-2026-11-05.json"), "utf8"));
const LEAKED: string[] = FIXTURE.leaks;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const PEER = "972500000000";
setWhatsAppCloudRuntime({ logging: { getChildLogger: () => log } });

function makeConfig(): WhatsAppCloudConfig {
  return {
    enabled: true,
    phoneNumberId: "111222333",
    businessAccountId: "444555666",
    accessToken: "test_token",
    appSecret: "test_secret",
    verifyToken: "test-verify",
    webhookPort: 3100,
    webhookPath: "/webhook/whatsapp-cloud",
    apiVersion: "v21.0",
    dmPolicy: "open",
    allowFrom: [],
    sendReadReceipts: true,
  } as WhatsAppCloudConfig;
}
const cfg = { channels: { "whatsapp-cloud": makeConfig() } };

function metaOk() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ messaging_product: "whatsapp", contacts: [], messages: [{ id: "wamid.sent" }] }),
  });
}
const messagePosts = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/messages"));
const alerts = () => readdirSync(ALERT_DIR).filter((f) => f.endsWith(".json"));

beforeEach(() => {
  mockFetch.mockReset();
  metaOk();
  for (const f of alerts()) rmSync(join(ALERT_DIR, f));
  Object.values(log).forEach((f) => f.mockClear());
});
afterAll(() => rmSync(ALERT_DIR, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The leak variants
// ---------------------------------------------------------------------------

const writeArgs = LEAKED[0];
const execArgs = LEAKED[2];
const inner = JSON.parse(writeArgs).content as string; // the payload itself, unescaped

const VARIANTS: Record<string, string> = {
  "exact leak 1 (16:29, write args)": LEAKED[0],
  "exact leak 2 (16:30, write args)": LEAKED[1],
  "exact leak 3 (17:24, exec args)": LEAKED[2],
  "fenced json": "```json\n" + inner + "\n```",
  "pretty-printed write args": JSON.stringify(JSON.parse(writeArgs), null, 2),
  "the payload itself, real Hebrew": JSON.stringify(JSON.parse(inner), null, 2),
  "payload as one line": JSON.stringify(JSON.parse(inner)),
  "a JSON array of tool calls": '[{"name":"exec","arguments":{"command":"bash x.sh"}}]',
  "prose then the args": "שומרת את הפרטים:\n" + execArgs,
  "xml tool markup": '<tool_call>{"name": "exec"}</tool_call>',
  "xai function markup": "<xai:function_call name=\"exec\"><parameter name=\"command\">ls</parameter></xai:function_call>",
  "invoke markup": '<invoke name="write"><parameter name="path">x</parameter></invoke>',
  "bare command": "bash ~/.openclaw/workspace/skills/lead-capture/submit-lead.sh /tmp/lead-payload.json",
  "bare command, no path": "submit-lead.sh",
  "heredoc command": "bash ~/.openclaw/workspace/skills/lead-capture/submit-lead.sh <<'EOF'\nאביב\nEOF",
  "internal path alone": "/tmp/lead-payload.json",
  "home path": "~/.openclaw/workspace/SKILL.md",
  "yaml-ish payload fields": "p_full_name: ישראל ישראלי\np_phone: 0500000000\np_consent_share: true",
  "wa_from field": "_wa_from = 972500000000",
  "key/value with single quotes": "{'command': 'ls'}",
  "escaped unicode only": "\\u05d0\\u05d1\\u05d9",
  "tool words": "stopReason: toolUse",
  "function_call json words": "function_call exec",
  "shell chain": "cd /app && node index.js",
  "command substitution": "echo $(cat /etc/passwd)",
  "curl to an api": "curl -s -X POST https://solarisrael-api.pinklime.io/rest/v1/rpc/submit_solar_lead -d @/tmp/x.json",
  "python call": "python3 /tmp/x.py",
  "openclaw cli": "openclaw agent --deliver /tmp/x",
  "shebang script": "#!/bin/bash\necho hi",
  "fullwidth braces": "｛\"a\": 1｝",
  "fullwidth backslash": "path＼to",
  "session id field": "session_id agent:main:whatsapp-cloud:direct:972500000000",
  "skill file name": "read skills/lead-capture first",
  "a .sh file name": "I'll run submit.sh now",
  "a .json file name": "saved to lead.json",
};

// Fragments: what the human-rhythm splitter or the 4096 split could produce.
function fragments(t: string): string[] {
  const out = new Set<string>();
  for (const p of t.split(/\n\s*\n/)) if (p.trim()) out.add(p);
  for (const l of t.split("\n")) if (l.trim()) out.add(l);
  return [...out];
}

describe("classifyOutboundText: every leak variant is withheld", () => {
  for (const [name, text] of Object.entries(VARIANTS)) {
    it(name, () => {
      const v = classifyOutboundText(text);
      expect(v.leak, `${name} was NOT flagged`).toBe(true);
      expect(v.reason).toBeTruthy();
    });
  }
});

describe("the exact leaked payloads, reason detail", () => {
  it("leak 1 and 2 are caught by the first structural rule", () => {
    expect(classifyOutboundText(LEAKED[0])).toEqual({ leak: true, reason: "starts-like-json" });
    expect(classifyOutboundText(LEAKED[1])).toEqual({ leak: true, reason: "starts-like-json" });
    expect(classifyOutboundText(LEAKED[2])).toEqual({ leak: true, reason: "starts-like-json" });
  });
  it("every line of the pretty-printed payload is caught alone, except bare punctuation", () => {
    // Bare `],` / `"storage"` lines are not prose either, but they never leave
    // alone: the whole reply is judged before any split (see send-path tests).
    const pretty = JSON.stringify(JSON.parse(inner), null, 2);
    const missed = fragments(pretty).filter((f) => !classifyOutboundText(f).leak);
    for (const m of missed) expect(m.trim()).toMatch(/^[\[\],"a-z\s]*$/);
  });
});

// ---------------------------------------------------------------------------
// Legitimate replies must still go out (false-positive check)
// ---------------------------------------------------------------------------

const LEGIT = [
  "היי! אני נגה מסולאר ישראל 😊 במה אפשר לעזור?",
  'מעולה. לגג של 80 מ"ר אפשר בדרך כלל מערכת של כ-15 קוט"ש, וההחזר הוא בסביבות 5-6 שנים. מה גובה החשבון החודשי בש"ח?',
  "רשמתי. מישהו מהצוות יחזור אליך בהקדם.",
  "אפשר שחברות מתמחות יחזרו אליך למספר הזה עם הצעה?",
  "יש כאן מאמר שמסביר את זה: https://solarisrael.co.il/articles/net-metering-2026/",
  "ניווט: https://waze.com/ul?ll=32.0853,34.7818&navigate=yes",
  "Sure! We're open Sun-Thu, 9:00-17:00. Call us at 054-1234567 or +972-3-555-1234.",
  "החשבון: 3,400 מ\"ר × 0.5 = בערך 1,700 ש\"ח בחודש (הערכה בלבד).",
  "שאלה אחת: זה בית פרטי או עסק?",
  "תודה רבה!! 🙏☀️",
  "הקורס מתחיל ב-1/12. פרטים: https://www.netanya.ac.il/programs/data-science?utm_source=wa",
  "Great question - yes, storage (batteries) works with net metering too.",
  "נשמע טוב. מתי נוח לך שיחזרו אליך: בוקר, צהריים או ערב?",
  "המחיר כולל מע\"מ: 4,990 ₪",
  "A link with a .json in it is fine: https://example.com/data/report.json",
];

describe("legitimate replies are NOT blocked", () => {
  for (const text of LEGIT) {
    it(text.slice(0, 50), () => {
      expect(classifyOutboundText(text)).toEqual({ leak: false, reason: null });
    });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("fail-closed", () => {
  it("non-string text is a leak", () => {
    expect(classifyOutboundText({ a: 1 } as any).leak).toBe(true);
    expect(classifyOutboundText(42 as any).leak).toBe(true);
  });
  it("nothing to send is not a leak", () => {
    expect(classifyOutboundText("").leak).toBe(false);
    expect(classifyOutboundText(undefined).leak).toBe(false);
  });
  it("a body whose getter throws is blocked (guard-error)", () => {
    const body: any = { type: "text", get text() { throw new Error("boom"); } };
    expect(outboundBodyVerdict(body)).toEqual({ leak: true, reason: "guard-error" });
  });
  it("a text body without a string body is blocked", () => {
    expect(outboundBodyVerdict({ type: "text", text: {} } as any).leak).toBe(true);
    expect(outboundBodyVerdict({ type: "text", text: { body: { x: 1 } } } as any).leak).toBe(true);
  });
  it("an unknown message type is blocked", () => {
    expect(outboundBodyVerdict({ type: "reaction", reaction: { emoji: "👍" } } as any)).toEqual({ leak: true, reason: "unknown-type:reaction" });
    expect(outboundBodyVerdict({ type: undefined } as any).leak).toBe(true);
    expect(outboundBodyVerdict(null as any).leak).toBe(true);
  });
  it("customerVisibleTexts reads interactive and template text", () => {
    const t = customerVisibleTexts({
      type: "interactive",
      interactive: {
        body: { text: "b" }, header: { text: "h" }, footer: { text: "f" },
        action: { button: "btn", buttons: [{ reply: { title: "r1" } }], sections: [{ title: "s", rows: [{ title: "row", description: "d" }] }], parameters: { flow_cta: "cta" } },
      },
    });
    expect(t).toEqual(["b", "h", "f", "btn", "r1", "s", "row", "d", "cta"]);
  });
});

// ---------------------------------------------------------------------------
// Every send path: Meta /messages is never called for a leak
// ---------------------------------------------------------------------------

describe("final gate (api.ts sendRequest): Meta is never called", () => {
  for (const [i, text] of LEAKED.entries()) {
    it(`sendText blocks exact leak ${i + 1}`, async () => {
      const r = await sendText(makeConfig(), PEER, text, log as any);
      expect(r).toMatchObject({ ok: false, blocked: true });
      expect(messagePosts()).toHaveLength(0);
      expect(log.error.mock.calls.flat().join(" ")).toMatch(/\[leak-guard\] BLOCKED/);
      expect(alerts()).toHaveLength(1);
    });
  }
  it("sendText blocks a leak longer than 4096 chars (before the chunk split)", async () => {
    const long = "שלום ".repeat(900) + "\n" + "x".repeat(10) + LEAKED[0];
    const r = await sendText(makeConfig(), PEER, long, log as any);
    expect(r.blocked).toBe(true);
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendMedia blocks a leaked caption", async () => {
    const r = await sendMedia(makeConfig(), PEER, "image", { link: "https://x/y.jpg", caption: LEAKED[2] }, log as any);
    expect(r.blocked).toBe(true);
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendMedia blocks a leaked document filename", async () => {
    const r = await sendMedia(makeConfig(), PEER, "document", { link: "https://x/y.pdf", filename: "submit-lead.sh" }, log as any);
    expect(r.blocked).toBe(true);
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendButtons / sendInteractive block leaked body text", async () => {
    expect((await sendButtons(makeConfig(), PEER, LEAKED[0], [{ id: "a", title: "כן" }], log as any)).blocked).toBe(true);
    expect((await sendInteractive(makeConfig(), PEER, { type: "button", body: { text: "בחרו" }, action: { buttons: [{ type: "reply", reply: { id: "a", title: "/tmp/x.sh" } }] } } as any, log as any)).blocked).toBe(true);
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendTemplate blocks a leaked text parameter", async () => {
    const r = await sendTemplate(makeConfig(), PEER, "follow_up", "he", [{ type: "body", parameters: [{ type: "text", text: LEAKED[2] }] }] as any, log as any);
    expect(r.blocked).toBe(true);
    expect(messagePosts()).toHaveLength(0);
  });
  it("legit sends still reach Meta on every path", async () => {
    expect((await sendText(makeConfig(), PEER, LEGIT[1], log as any)).ok).toBe(true);
    expect((await sendMedia(makeConfig(), PEER, "image", { link: "https://x/y.jpg", caption: "הגג שלך ☀️" }, log as any)).ok).toBe(true);
    expect((await sendButtons(makeConfig(), PEER, "בית פרטי או עסק?", [{ id: "a", title: "בית" }], log as any)).ok).toBe(true);
    expect((await sendTemplate(makeConfig(), PEER, "follow_up", "he", [{ type: "body", parameters: [{ type: "text", text: "נגה" }] }] as any, log as any)).ok).toBe(true);
    expect(messagePosts()).toHaveLength(4);
    expect(alerts()).toHaveLength(0);
  });
});

describe("outbound adapter (message tool, `openclaw agent --deliver`, runtime notices)", () => {
  for (const [i, text] of LEAKED.entries()) {
    it(`sendText suppresses exact leak ${i + 1} without throwing`, async () => {
      const r = await outbound.sendText({ cfg, to: PEER, text });
      expect(r.messageId).toBe("suppressed:leak-guard");
      expect(messagePosts()).toHaveLength(0);
    });
  }
  it("sendText suppresses a pretty-printed leak that the splitter would cut into harmless-looking parts", async () => {
    const r = await outbound.sendText({ cfg, to: PEER, text: JSON.stringify(JSON.parse(inner), null, 2).replace(/\n/g, "\n\n") });
    expect(r.messageId).toBe("suppressed:leak-guard");
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendMedia with a leaked caption is suppressed, nothing posted to /messages", async () => {
    const r = await outbound.sendMedia({ cfg, to: PEER, text: LEAKED[2], mediaUrl: "https://example.com/a.jpg" });
    expect(r.messageId).toBe("suppressed:leak-guard");
    expect(messagePosts()).toHaveLength(0);
  });
  it("sendMedia text fallback with a leak is suppressed", async () => {
    const r = await outbound.sendMedia({ cfg, to: PEER, text: LEAKED[0] });
    expect(r.messageId).toBe("suppressed:leak-guard");
    expect(messagePosts()).toHaveLength(0);
  });
  it("a legit adapter send still goes out", async () => {
    const r = await outbound.sendText({ cfg, to: PEER, text: LEGIT[2] });
    expect(r.messageId).toBe("wamid.sent");
    expect(messagePosts()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Alerts and the retry notice
// ---------------------------------------------------------------------------

describe("recordLeak / retry notice", () => {
  it("writes one masked alert file per event", () => {
    const name = recordLeak({ stage: "retry-failed", reason: "starts-like-json", to: PEER, text: LEAKED[0], sessionKey: "agent:main:x", messageId: "wamid.1" });
    expect(name).toMatch(/retry-failed-[0-9a-f]{6}\.json$/);
    const f = join(ALERT_DIR, name!);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j).toMatchObject({ version: 1, stage: "retry-failed", reason: "starts-like-json", peer: PEER, sessionKey: "agent:main:x", inboundMessageId: "wamid.1" });
    expect(j.snippet.length).toBeLessThanOrEqual(161);
    expect(j.snippet).not.toContain("972500000000");
  });
  it("never throws, even when the directory cannot be created", () => {
    const notADir = join(ALERT_DIR, "plain-file");
    writeFileSync(notADir, "x");
    expect(recordLeak({ stage: "turn", reason: "x", text: "y" }, join(notADir, "sub"))).toBeNull();
    rmSync(notADir);
  });
  it("snippet masks phone numbers", () => {
    expect(leakSnippet("call +972 50 000 0000 now")).not.toMatch(/\d{7}/);
  });
  it("retry notice is marked for the dashboard and is not itself sendable", () => {
    const b = buildLeakRetryBody("starts-like-json");
    expect(b.startsWith(LEAK_RETRY_OPEN)).toBe(true);
    // The notice goes to the model, never to the customer; it contains no code.
    expect(b).not.toMatch(/[{}\\]/);
  });
});

// Full send-path coverage, so a new path added later fails here.
describe("only sendRequest POSTs to /messages", () => {
  it("api.ts has exactly one fetch to /messages that carries customer text", async () => {
    const src = readFileSync(join(__dirname, "..", "api.ts"), "utf8");
    const fetches = src.match(/await fetch\(/g) ?? [];
    // sendRequest, uploadMedia (/media), markAsRead, sendTypingIndicator, getMediaUrl, downloadMedia
    expect(fetches).toHaveLength(6);
    const sendRequestBody = src.slice(src.indexOf("async function sendRequest("), src.indexOf("export async function sendText("));
    expect(sendRequestBody.indexOf("outboundBodyVerdict(body)")).toBeGreaterThan(-1);
    expect(sendRequestBody.indexOf("outboundBodyVerdict(body)")).toBeLessThan(sendRequestBody.indexOf("await fetch("));
    for (const f of ["index.ts", "media.ts", "human.ts", "handback.ts", "first-reply.ts", "referral.ts", "block.ts", "webhook.ts"]) {
      const s = readFileSync(join(__dirname, "..", f), "utf8");
      expect(s, `${f} must not call fetch directly`).not.toMatch(/\bfetch\(/);
    }
  });
});
