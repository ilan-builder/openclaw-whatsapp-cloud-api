import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistoryBody,
  firstName,
  firstReplyStatus,
  firstReplyUsable,
  isExpired,
  maskPeer,
  matchIndex,
  normalizeForMatch,
  readEntry,
  renderFirstReply,
  resolveFirstReply,
  stateFileName,
  writeEntry,
  type FirstReplyEntry,
} from "../first-reply.js";

const PREFILL = "היי, אשמח לקבל פרטים";

describe("resolveFirstReply", () => {
  it("is off with an empty match list by default", () => {
    const cfg = resolveFirstReply(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.match).toEqual([]);
    expect(firstReplyUsable(cfg)).toBe(false);
  });

  it("needs a match list AND a text to be usable", () => {
    expect(firstReplyUsable(resolveFirstReply({ enabled: true, match: [PREFILL] }))).toBe(false);
    expect(firstReplyUsable(resolveFirstReply({ enabled: true, text: "hi" }))).toBe(false);
    expect(
      firstReplyUsable(resolveFirstReply({ enabled: true, match: [PREFILL], text: "hi" }))
    ).toBe(true);
  });

  it("defaults textNoName to text and keeps an explicit one", () => {
    expect(resolveFirstReply({ text: "a" }).textNoName).toBe("a");
    expect(resolveFirstReply({ text: "a", textNoName: "b" }).textNoName).toBe("b");
  });
});

// The base layer ships `enabled: true` for every agent, so "switched on with
// nothing to say" is a normal state — a client that has not written its texts
// yet. It must behave EXACTLY like off, and say so once at startup.
describe("enabled but empty", () => {
  it("is inactive when the text is empty or whitespace", () => {
    expect(firstReplyUsable(resolveFirstReply({ enabled: true, match: [PREFILL], text: "" }))).toBe(
      false
    );
    expect(
      firstReplyUsable(
        resolveFirstReply({ enabled: true, match: [PREFILL], text: "  \n\t ", textNoName: " " })
      )
    ).toBe(false);
  });

  it("is ACTIVE when only textNoName is configured", () => {
    const cfg = resolveFirstReply({ enabled: true, match: [PREFILL], textNoName: "היי, בשמחה" });
    expect(firstReplyUsable(cfg)).toBe(true);
    expect(firstReplyStatus(cfg).active).toBe(true);
  });

  it("never renders an empty reply when one of the two texts is missing", () => {
    const noText = resolveFirstReply({ enabled: true, match: [PREFILL], textNoName: "היי, בשמחה" });
    expect(renderFirstReply(noText, "אילן")).toBe("היי, בשמחה");
    const noNoName = resolveFirstReply({
      enabled: true,
      match: [PREFILL],
      text: "היי{name_comma} בשמחה",
      textNoName: "   ",
    });
    expect(renderFirstReply(noNoName, null)).toBe("היי, בשמחה");
  });

  it("reports one startup line per state", () => {
    expect(firstReplyStatus(resolveFirstReply({ enabled: false })).line).toBe(
      "[first-reply] disabled"
    );
    expect(firstReplyStatus(resolveFirstReply({ enabled: true, match: [PREFILL] })).line).toBe(
      "[first-reply] enabled but no text configured; inactive"
    );
    expect(firstReplyStatus(resolveFirstReply({ enabled: true, text: "hi" })).line).toBe(
      "[first-reply] enabled but no match openers configured; inactive"
    );
    const on = firstReplyStatus(resolveFirstReply({ enabled: true, match: [PREFILL], text: "hi" }));
    expect(on.active).toBe(true);
    expect(on.line).toBe("[first-reply] ACTIVE — 1 opener(s), cooldown 30d");
  });
});

describe("matching", () => {
  it("matches the prefill exactly, ignoring whitespace and bidi marks", () => {
    const patterns = [PREFILL];
    expect(matchIndex(PREFILL, patterns)).toBe(0);
    expect(matchIndex(`  ${PREFILL}\n`, patterns)).toBe(0);
    expect(matchIndex(`‏${PREFILL}‎`, patterns)).toBe(0);
    expect(matchIndex("היי,   אשמח לקבל פרטים", patterns)).toBe(0);
  });

  it("NEVER matches a prefix or a superstring", () => {
    const patterns = [PREFILL];
    // 7.6% of real openers are the prefill with a question glued on. Those are
    // customers who asked something and must reach the model.
    expect(matchIndex(`${PREFILL}Is this a kosher restaurant?`, patterns)).toBe(-1);
    expect(matchIndex(`${PREFILL} על חתונה`, patterns)).toBe(-1);
    expect(matchIndex("היי", patterns)).toBe(-1);
    expect(matchIndex("", patterns)).toBe(-1);
  });

  it("reports which pattern matched", () => {
    expect(matchIndex("hello", ["hi", "hello"])).toBe(1);
  });

  it("normalizes to a single-space form", () => {
    expect(normalizeForMatch(" a   b\n")).toBe("a b");
  });
});

describe("firstName", () => {
  it("accepts a plain first name", () => {
    expect(firstName("אילן")).toBe("אילן");
    expect(firstName("Adrian")).toBe("Adrian");
    expect(firstName("נועה כהן")).toBe("נועה");
  });

  it("rejects a phone number, an emoji handle and a long business name", () => {
    expect(firstName("972501234567")).toBeNull();
    expect(firstName("+972501234567")).toBeNull();
    expect(firstName("✨")).toBeNull();
    expect(firstName("Porcini Catering & Events")).toBeNull();
    expect(firstName("")).toBeNull();
    expect(firstName(null)).toBeNull();
  });
});

describe("renderFirstReply", () => {
  const cfg = resolveFirstReply({
    enabled: true,
    match: [PREFILL],
    text: "היי{name_comma} בשמחה 🙂\n\nכאן מאיה.",
    textNoName: "היי, בשמחה 🙂\n\nאיך קוראים לך?",
  });

  it("inserts the name with a comma", () => {
    expect(renderFirstReply(cfg, "אילן")).toBe("היי אילן, בשמחה 🙂\n\nכאן מאיה.");
  });

  it("uses the no-name text when there is no usable name", () => {
    expect(renderFirstReply(cfg, null)).toBe("היי, בשמחה 🙂\n\nאיך קוראים לך?");
  });

  it("falls back to text when no textNoName is configured", () => {
    const bare = resolveFirstReply({ text: "היי{name_comma} בשמחה" });
    expect(renderFirstReply(bare, null)).toBe("היי, בשמחה");
  });
});

describe("state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "first-reply-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry = (over: Partial<FirstReplyEntry> = {}): FirstReplyEntry => ({
    peer: "972501234567",
    senderName: "אילן",
    inbound: { text: PREFILL, ts: "2026-08-29T09:00:00.000Z", waMessageId: "wamid.A" },
    reply: { text: "היי אילן, בשמחה", ts: "2026-08-29T09:00:11.000Z", waMessageId: "wamid.B" },
    continuedAt: null,
    sessionKey: "agent:main:whatsapp-cloud:direct:972501234567",
    ...over,
  });

  it("round-trips an entry", async () => {
    const cfg = { ...resolveFirstReply({}), stateDir: dir };
    await writeEntry(cfg, entry());
    const back = await readEntry(cfg, "972501234567");
    expect(back?.inbound.waMessageId).toBe("wamid.A");
    expect(back?.continuedAt).toBeNull();
  });

  it("returns null for an unknown peer", async () => {
    const cfg = { ...resolveFirstReply({}), stateDir: dir };
    expect(await readEntry(cfg, "972500000000")).toBeNull();
  });

  it("never lets a peer id escape the state directory", () => {
    expect(stateFileName("../../etc/passwd")).toBe("______etc_passwd.json");
    expect(stateFileName("972501234567")).toBe("972501234567.json");
  });
});

describe("isExpired", () => {
  const base = {
    peer: "1",
    senderName: null,
    inbound: { text: PREFILL, ts: "2026-08-01T00:00:00.000Z", waMessageId: "a" },
    reply: { text: "hi", ts: "2026-08-01T00:00:10.000Z" },
    continuedAt: null,
    sessionKey: "k",
  } as FirstReplyEntry;
  const now = Date.parse("2026-08-29T00:00:00.000Z");

  it("is fresh inside the cooldown", () => {
    expect(isExpired(base, 30, now)).toBe(false);
  });

  it("is expired past the cooldown", () => {
    expect(isExpired(base, 14, now)).toBe(true);
  });

  it("never expires when the cooldown is 0", () => {
    expect(isExpired(base, 0, now)).toBe(false);
  });
});

describe("buildHistoryBody", () => {
  it("wraps the two messages in one parseable block ahead of the new text", () => {
    const e: FirstReplyEntry = {
      peer: "972501234567",
      senderName: "אילן",
      inbound: { text: PREFILL, ts: "2026-08-29T09:00:00.000Z", waMessageId: "a" },
      reply: { text: "היי אילן, בשמחה 🙂\n\nכאן מאיה.", ts: "2026-08-29T09:00:11.000Z" },
      continuedAt: null,
      sessionKey: "k",
    };
    const body = buildHistoryBody(e, "חתונה, 200 אורחים", "PRE");
    expect(body).toBe(
      [
        "[PINKLIME_HISTORY]",
        "PRE",
        "<<<user 2026-08-29T09:00:00.000Z>>>",
        PREFILL,
        "<<<assistant 2026-08-29T09:00:11.000Z>>>",
        "היי אילן, בשמחה 🙂",
        "",
        "כאן מאיה.",
        "[/PINKLIME_HISTORY]",
        "חתונה, 200 אורחים",
      ].join("\n")
    );
  });
});

describe("maskPeer", () => {
  it("keeps the country prefix and the last two digits", () => {
    expect(maskPeer("972501234567")).toBe("9725******67");
    expect(maskPeer("12345")).toBe("12345");
  });
});
