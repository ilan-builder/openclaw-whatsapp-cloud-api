import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendBlockedMessage,
  blockFileName,
  blockLogName,
  clearBlock,
  findBlockMarker,
  maskPeer,
  payloadHasMarker,
  readBlock,
  resolveBlock,
  writeBlock,
  type BlockConfig,
  type BlockEntry,
} from "../block.js";
import { splitIntoParts, resolveHumanRhythm } from "../human.js";

const MARKER = "PINKLIME_BLOCK";

let dir = "";
let cfg: BlockConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "block-test-"));
  cfg = resolveBlock({ stateDir: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (over: Partial<BlockEntry> = {}): BlockEntry => ({
  peer: "972541234567",
  reason: "abusive",
  source: "bot",
  blockedAt: "2026-09-12T10:00:00.000Z",
  blockedBy: "main",
  triggerText: "זין וכוס🥹",
  sessionKey: "agent:main:whatsapp-cloud:direct:972541234567",
  ...over,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("resolveBlock", () => {
  it("is ON by default — the dashboard's Block button must work for every client", () => {
    const c = resolveBlock(undefined);
    expect(c.enabled).toBe(true);
    expect(c.marker).toBe(MARKER);
    expect(c.logMax).toBe(200);
  });

  it("can be switched off, and takes a client's own marker and state dir", () => {
    const c = resolveBlock({ enabled: false, marker: " TROLL ", stateDir: "/tmp/x", logMax: 5 });
    expect(c.enabled).toBe(false);
    expect(c.marker).toBe("TROLL");
    expect(c.stateDir).toBe("/tmp/x");
    expect(c.logMax).toBe(5);
  });

  it("ignores a blank marker rather than matching every reply", () => {
    expect(resolveBlock({ marker: "   " }).marker).toBe(MARKER);
  });
});

// ---------------------------------------------------------------------------
// Finding the marker
// ---------------------------------------------------------------------------

describe("findBlockMarker", () => {
  it("finds the marker on its own", () => {
    expect(findBlockMarker(MARKER, MARKER)).toEqual({ found: true, reason: null });
  });

  it("finds it with text around it — the model that obeys almost still blocks", () => {
    expect(findBlockMarker(`מצטערת, לא אוכל להמשיך. ${MARKER}`, MARKER).found).toBe(true);
    expect(findBlockMarker(`${MARKER}\n\nתודה ויום נעים`, MARKER).found).toBe(true);
    expect(findBlockMarker(`  ${MARKER}.  `, MARKER).found).toBe(true);
  });

  it("reads the agent's reason and lower-cases it", () => {
    expect(findBlockMarker(`${MARKER}:abusive`, MARKER)).toEqual({
      found: true,
      reason: "abusive",
    });
    expect(findBlockMarker(`${MARKER}:Gibberish`, MARKER).reason).toBe("gibberish");
  });

  it("blocks with no reason when the suffix is not one", () => {
    expect(findBlockMarker(`${MARKER}: `, MARKER)).toEqual({ found: true, reason: null });
  });

  it("does not fire on a normal reply", () => {
    expect(findBlockMarker("היי! מאיזה תאריך מדובר?", MARKER).found).toBe(false);
    expect(findBlockMarker("", MARKER).found).toBe(false);
    expect(findBlockMarker(undefined as any, MARKER).found).toBe(false);
  });

  it("treats a configured marker as a literal, never as a regex", () => {
    expect(findBlockMarker("anything at all", "a.*z").found).toBe(false);
    expect(findBlockMarker("a.*z", "a.*z").found).toBe(true);
  });
});

describe("payloadHasMarker", () => {
  it("looks at text, body and caption", () => {
    expect(payloadHasMarker({ text: MARKER }, MARKER).found).toBe(true);
    expect(payloadHasMarker({ body: MARKER }, MARKER).found).toBe(true);
    expect(payloadHasMarker({ caption: `${MARKER}:gibberish` }, MARKER).reason).toBe("gibberish");
  });

  it("is quiet for a payload that only carries media", () => {
    expect(payloadHasMarker({ mediaUrls: ["file:///a.jpg"] }, MARKER).found).toBe(false);
    expect(payloadHasMarker(null, MARKER).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The whole-turn verdict — the humanRhythm split must not leak a part
// ---------------------------------------------------------------------------

/**
 * A miniature of the `deliver` callback in index.ts: the marker decides the
 * whole turn, and a payload is only split into WhatsApp messages AFTER the
 * verdict says nothing is suppressed.
 */
function runTurn(payloads: any[], marker: string) {
  const rhythm = resolveHumanRhythm({ enabled: true, splitParagraphs: true });
  const verdict = { hit: false, reason: null as string | null };
  const sent: string[] = [];
  const media: string[] = [];
  for (const p of payloads) {
    if (!verdict.hit) {
      const marked = payloadHasMarker(p, marker);
      if (marked.found) {
        verdict.hit = true;
        verdict.reason = marked.reason;
      }
    }
    if (verdict.hit) continue;
    if (p.text) sent.push(...splitIntoParts(p.text, rhythm));
    for (const u of p.mediaUrls ?? []) media.push(u);
  }
  return { verdict, sent, media };
}

describe("the verdict covers the whole turn", () => {
  it("sends nothing at all when the reply is only the marker", () => {
    const r = runTurn([{ text: MARKER }], MARKER);
    expect(r.verdict.hit).toBe(true);
    expect(r.sent).toEqual([]);
  });

  it("leaks no part of a multi-part humanRhythm reply", () => {
    // Two paragraphs would normally become two WhatsApp messages. The marker is
    // in the second one; neither may be sent.
    const r = runTurn([{ text: `מצטערת, אני מסיימת כאן.\n\n${MARKER}:abusive` }], MARKER);
    expect(r.verdict.hit).toBe(true);
    expect(r.verdict.reason).toBe("abusive");
    expect(r.sent).toEqual([]);
  });

  it("suppresses every later block of the turn once the marker is seen", () => {
    const r = runTurn(
      [{ text: MARKER }, { text: "ואיפה האירוע?" }, { mediaUrls: ["file:///menu.jpg"] }],
      MARKER
    );
    expect(r.sent).toEqual([]);
    expect(r.media).toEqual([]);
  });

  it("suppresses media that arrives in the SAME payload as the marker", () => {
    const r = runTurn([{ text: MARKER, mediaUrls: ["file:///menu.jpg"] }], MARKER);
    expect(r.sent).toEqual([]);
    expect(r.media).toEqual([]);
  });

  it("changes nothing for an ordinary reply", () => {
    const r = runTurn([{ text: "היי 🙂\n\nמאיזה תאריך מדובר?" }], MARKER);
    expect(r.verdict.hit).toBe(false);
    expect(r.sent).toEqual(["היי 🙂", "מאיזה תאריך מדובר?"]);
  });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe("block state", () => {
  it("writes and reads a block round trip", async () => {
    await writeBlock(cfg, entry());
    const back = await readBlock(cfg, "972541234567");
    expect(back?.reason).toBe("abusive");
    expect(back?.source).toBe("bot");
    expect(back?.triggerText).toBe("זין וכוס🥹");
  });

  it("writes atomically — no .tmp file survives", async () => {
    await writeBlock(cfg, entry());
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    expect(names).toEqual(["972541234567.json"]);
  });

  it("reports an absent, malformed or peer-less file as not blocked", async () => {
    expect(await readBlock(cfg, "972540000000")).toBeNull();
    await writeFile(join(dir, blockFileName("972541111111")), "{ not json", "utf-8");
    expect(await readBlock(cfg, "972541111111")).toBeNull();
    await writeFile(join(dir, blockFileName("972542222222")), "{}", "utf-8");
    expect(await readBlock(cfg, "972542222222")).toBeNull();
  });

  it("unmutes, and says whether anything was there", async () => {
    await writeBlock(cfg, entry());
    expect(await clearBlock(cfg, "972541234567")).toBe(true);
    expect(await readBlock(cfg, "972541234567")).toBeNull();
    expect(await clearBlock(cfg, "972541234567")).toBe(false);
  });

  it("never lets a peer id escape the state dir", () => {
    expect(blockFileName("../../etc/passwd")).toBe("______etc_passwd.json");
    expect(blockFileName("")).toBe("unknown.json");
    expect(blockLogName("972541234567")).toBe("972541234567.jsonl");
  });
});

describe("the dropped-message log", () => {
  const msg = (text: string) => ({
    ts: "2026-09-12T10:01:00.000Z",
    waMessageId: `wamid.${text}`,
    type: "text",
    text,
    senderName: "Troll",
  });

  it("appends one line per dropped message", async () => {
    await appendBlockedMessage(cfg, "972541234567", msg("שחש"));
    await appendBlockedMessage(cfg, "972541234567", msg("תה ג"));
    const lines = (await readFile(join(dir, blockLogName("972541234567")), "utf-8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe("שחש");
  });

  it("stops at logMax instead of letting a troll fill the volume", async () => {
    const capped = resolveBlock({ stateDir: dir, logMax: 2 });
    for (const t of ["a", "b", "c", "d"]) await appendBlockedMessage(capped, "9725", msg(t));
    const lines = (await readFile(join(dir, blockLogName("9725")), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("writes nothing when logging is switched off", async () => {
    const off = resolveBlock({ stateDir: dir, logMax: 0 });
    await appendBlockedMessage(off, "9725", msg("a"));
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("maskPeer", () => {
  it("keeps the country prefix and the last two digits", () => {
    expect(maskPeer("972541234567")).toBe("9725******67");
    expect(maskPeer("1234")).toBe("1234");
  });
});

// ---------------------------------------------------------------------------
// Enforcement, through the real webhook server
// ---------------------------------------------------------------------------

const readReceipts: string[] = [];
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    markAsRead: (_cfg: any, id: string) => {
      readReceipts.push(id);
      return Promise.resolve({ ok: true });
    },
  };
});

const { startWebhookServer } = await import("../webhook.js");
const { CONFIG_DEFAULTS } = await import("../types.js");

const TEST_PORT = 13190;
const APP_SECRET = "block_test_secret";

function makeConfig(overrides: Record<string, any> = {}): any {
  return {
    ...CONFIG_DEFAULTS,
    enabled: true,
    phoneNumberId: "111222333",
    businessAccountId: "444555666",
    accessToken: "test_token",
    appSecret: APP_SECRET,
    verifyToken: "test-verify",
    webhookPort: TEST_PORT,
    webhookPath: "/webhook/whatsapp-cloud",
    apiVersion: "v21.0",
    dmPolicy: "open",
    allowFrom: [],
    sendReadReceipts: true, // the point of these tests: it must NOT fire
    flows: {},
    ...overrides,
  };
}

function payload(from: string, text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "BUSINESS_ACCOUNT_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001234", phone_number_id: "111222333" },
              contacts: [{ profile: { name: "Troll" }, wa_id: from }],
              messages: [
                { from, id: `wamid.${from}.${text}`, timestamp: "1700000000", type: "text", text: { body: text } },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

async function post(body: unknown): Promise<void> {
  const raw = JSON.stringify(body);
  await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/whatsapp-cloud`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  // The handler ACKs before it processes; give the async work a tick to land.
  await new Promise((r) => setTimeout(r, 60));
}

describe("enforcement", () => {
  const PEER = "972545550001";
  let server: any;
  let seen: any[];

  beforeEach(async () => {
    readReceipts.length = 0;
    seen = [];
    server = startWebhookServer(
      makeConfig({ block: resolveBlock({ stateDir: dir }) }),
      (m: any) => { seen.push(m); },
      undefined,
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
    );
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(() => {
    server?.close();
  });

  it("dispatches, and reads, a peer who is not blocked", async () => {
    await post(payload(PEER, "היי, יש לכם תפריט טבעוני?"));
    expect(seen).toHaveLength(1);
    expect(readReceipts).toHaveLength(1);
  });

  it("never dispatches a blocked peer, and sends no read receipt", async () => {
    await writeBlock(cfg, entry({ peer: PEER }));
    await post(payload(PEER, "עוד קללה"));
    expect(seen).toHaveLength(0);
    expect(readReceipts).toHaveLength(0);
  });

  it("keeps the dropped message where an operator can read it", async () => {
    await writeBlock(cfg, entry({ peer: PEER }));
    await post(payload(PEER, "עוד קללה"));
    const lines = (await readFile(join(dir, blockLogName(PEER)), "utf-8")).trim().split("\n");
    expect(JSON.parse(lines[0]).text).toBe("עוד קללה");
  });

  it("resumes on the very next message after an unmute — the file is read, never cached", async () => {
    await writeBlock(cfg, entry({ peer: PEER }));
    await post(payload(PEER, "one"));
    expect(seen).toHaveLength(0);
    await clearBlock(cfg, PEER);
    await post(payload(PEER, "two"));
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("two");
  });

  it("lets `/new` through, carrying the block, so index.ts can decide the unmute", async () => {
    await writeBlock(cfg, entry({ peer: PEER }));
    await post(payload(PEER, "/new"));
    expect(seen).toHaveLength(1);
    expect(seen[0].blocked?.peer).toBe(PEER);
    expect(readReceipts).toHaveLength(0); // still no sign of life for a troll
  });

  it("attaches nothing to a normal message from an unblocked peer", async () => {
    await post(payload(PEER, "/new"));
    expect(seen[0].blocked).toBeUndefined();
  });

  it("does not enforce when the feature is switched off", async () => {
    server.close();
    seen = [];
    server = startWebhookServer(
      makeConfig({ webhookPort: TEST_PORT, block: resolveBlock({ enabled: false, stateDir: dir }) }),
      (m: any) => { seen.push(m); },
      undefined,
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
    );
    await new Promise((r) => setTimeout(r, 50));
    await writeBlock(cfg, entry({ peer: PEER }));
    await post(payload(PEER, "still talking"));
    expect(seen).toHaveLength(1);
  });
});
