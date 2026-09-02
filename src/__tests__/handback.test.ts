import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTakeoverBody,
  claimHandback,
  resolveHandback,
  stateFileName,
  validateEntry,
  TAKEOVER_OPEN,
  TAKEOVER_CLOSE,
  type HandbackConfig,
  type HandbackEntry,
} from "../handback.js";

const PEER = "972543343052";

const entryFor = (over: Partial<HandbackEntry> = {}): HandbackEntry => ({
  version: "takeover-v1",
  peer: PEER,
  heldBy: "אילן",
  heldFrom: "2026-09-02T09:00:00.000Z",
  heldTo: "2026-09-02T09:12:00.000Z",
  preamble: "A human colleague answered this customer directly.",
  turns: [
    { role: "assistant", ts: "2026-09-02T09:00:01.000Z", text: "היי, כאן אילן מהצוות", human: true },
    { role: "user", ts: "2026-09-02T09:01:00.000Z", text: "מה השעות?" },
    { role: "assistant", ts: "2026-09-02T09:02:00.000Z", text: "פתוח עד 17:00", human: true },
  ],
  truncated: false,
  replayedAt: null,
  ...over,
});

describe("resolveHandback", () => {
  it("is ON by default — there is nothing for a client to configure", () => {
    const cfg = resolveHandback(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.stateDir.endsWith("/takeover")).toBe(true);
  });

  it("can be switched off, and takes an explicit state dir", () => {
    expect(resolveHandback({ enabled: false }).enabled).toBe(false);
    expect(resolveHandback({ stateDir: "/tmp/x" }).stateDir).toBe("/tmp/x");
  });
});

describe("stateFileName", () => {
  it("never lets a peer escape the directory", () => {
    expect(stateFileName(PEER)).toBe(`${PEER}.json`);
    expect(stateFileName("../../etc/passwd")).toBe("______etc_passwd.json");
    expect(stateFileName("")).toBe("unknown.json");
  });
});

describe("validateEntry", () => {
  it("accepts a well-formed file and keeps only usable turns", () => {
    const ok = validateEntry(entryFor(), PEER);
    expect(ok?.turns).toHaveLength(3);
  });

  it("refuses a file that names a different peer", () => {
    expect(validateEntry(entryFor({ peer: "972500000000" }), PEER)).toBeNull();
  });

  it("refuses anything without at least one turn with text", () => {
    expect(validateEntry({ peer: PEER, turns: [] }, PEER)).toBeNull();
    expect(validateEntry({ peer: PEER, turns: [{ role: "assistant", text: "  " }] }, PEER)).toBeNull();
    expect(validateEntry({ peer: PEER }, PEER)).toBeNull();
    expect(validateEntry(null, PEER)).toBeNull();
    expect(validateEntry("nope", PEER)).toBeNull();
  });

  it("drops a turn with an unknown role rather than the whole file", () => {
    const e = validateEntry(
      { peer: PEER, turns: [{ role: "system", text: "x" }, { role: "user", text: "y" }] },
      PEER
    );
    expect(e?.turns).toEqual([{ role: "user", ts: null, text: "y" }]);
  });
});

describe("claimHandback", () => {
  let dir: string;
  let cfg: HandbackConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "handback-"));
    cfg = { enabled: true, stateDir: dir };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = (data: unknown, peer = PEER) =>
    writeFile(join(dir, stateFileName(peer)), typeof data === "string" ? data : JSON.stringify(data), "utf-8");

  it("returns nothing for a peer with no file, and consumes nothing", async () => {
    const r = await claimHandback(cfg, PEER);
    expect(r.entry).toBeNull();
    expect(r.consumed).toBe(false);
  });

  it("replays ONCE: the second claim finds nothing", async () => {
    await put(entryFor());
    const first = await claimHandback(cfg, PEER);
    expect(first.entry?.turns).toHaveLength(3);
    const second = await claimHandback(cfg, PEER);
    expect(second.entry).toBeNull();
    expect(second.consumed).toBe(false);
  });

  it("consumes the file — it is gone, and the claimed copy is stamped", async () => {
    await put(entryFor());
    await claimHandback(cfg, PEER);
    const files = await readdir(dir);
    expect(files).not.toContain(`${PEER}.json`);
    expect(files).toContain(`${PEER}.replayed.json`);
    const saved = JSON.parse(await readFile(join(dir, `${PEER}.replayed.json`), "utf-8"));
    expect(typeof saved.replayedAt).toBe("string");
  });

  it("ignores a malformed file AND consumes it, so it is not retried forever", async () => {
    await put("{ this is not json");
    const r = await claimHandback(cfg, PEER);
    expect(r.entry).toBeNull();
    expect(r.consumed).toBe(true);
    expect(r.malformed).toBe(true);
    expect(await readdir(dir)).not.toContain(`${PEER}.json`);
  });

  it("ignores a file that carries no usable turn", async () => {
    await put({ peer: PEER, turns: [{ role: "assistant" }] });
    const r = await claimHandback(cfg, PEER);
    expect(r.entry).toBeNull();
    expect(r.malformed).toBe(true);
  });

  it("only ever reads its own peer's file", async () => {
    await put(entryFor({ peer: "972500000000" }), "972500000000");
    const r = await claimHandback(cfg, PEER);
    expect(r.entry).toBeNull();
    expect(await readdir(dir)).toContain("972500000000.json");
  });
});

describe("buildTakeoverBody", () => {
  it("wraps the turns in the takeover marker and keeps the new message last", () => {
    const body = buildTakeoverBody(entryFor(), "ומה עם יום שישי?");
    expect(body.startsWith(TAKEOVER_OPEN)).toBe(true);
    expect(body.endsWith("ומה עם יום שישי?")).toBe(true);
    expect(body).toContain("<<<assistant 2026-09-02T09:00:01.000Z>>>");
    expect(body).toContain("<<<user 2026-09-02T09:01:00.000Z>>>");
    expect(body.indexOf(TAKEOVER_CLOSE)).toBeLessThan(body.indexOf("ומה עם יום שישי?"));
    // The preamble is inside the block: the model reads it, nobody else does.
    expect(body).toContain("A human colleague answered this customer directly.");
  });

  it("uses its own preamble when the file carries none", () => {
    const body = buildTakeoverBody(entryFor({ preamble: "" }), "x");
    expect(body).toContain("A human colleague from the team answered this customer directly.");
  });

  it("emits a role marker with no timestamp when the turn has none", () => {
    const body = buildTakeoverBody(entryFor({ turns: [{ role: "user", text: "hi" }] }), "x");
    expect(body).toContain("<<<user>>>\nhi");
  });

  it("keeps an existing firstReply block FIRST — it is the older exchange", () => {
    const history = [
      "[PINKLIME_HISTORY]",
      "preamble",
      "<<<user 2026-09-02T08:00:00.000Z>>>",
      "היי, אשמח לקבל פרטים",
      "<<<assistant 2026-09-02T08:00:05.000Z>>>",
      "היי!",
      "[/PINKLIME_HISTORY]",
      "ומה עם יום שישי?",
    ].join("\n");
    const body = buildTakeoverBody(entryFor(), history);
    expect(body.startsWith("[PINKLIME_HISTORY]")).toBe(true);
    expect(body.indexOf("[/PINKLIME_HISTORY]")).toBeLessThan(body.indexOf(TAKEOVER_OPEN));
    expect(body.endsWith("ומה עם יום שישי?")).toBe(true);
    // …and each block closes before the next one opens.
    expect(body.indexOf(TAKEOVER_OPEN)).toBeLessThan(body.indexOf(TAKEOVER_CLOSE));
  });
});
