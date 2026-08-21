import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveHumanRhythm,
  splitIntoParts,
  createReplyPacer,
  HUMAN_RHYTHM_DEFAULTS,
} from "../human.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
const cfg = { phoneNumberId: "1", accessToken: "t", apiVersion: "v21.0" } as any;

describe("resolveHumanRhythm", () => {
  it("is off unless the config asks for it", () => {
    expect(resolveHumanRhythm(undefined).enabled).toBe(false);
    expect(resolveHumanRhythm({}).enabled).toBe(false);
    expect(resolveHumanRhythm({ enabled: true }).enabled).toBe(true);
  });

  it("keeps the defaults for the values it was not given", () => {
    const r = resolveHumanRhythm({ enabled: true, minMs: 9000 });
    expect(r.minMs).toBe(9000);
    expect(r.maxMs).toBe(HUMAN_RHYTHM_DEFAULTS.maxMs);
    expect(r.typingAfterMs).toBe(HUMAN_RHYTHM_DEFAULTS.typingAfterMs);
  });

  it("never lets max fall below min", () => {
    const r = resolveHumanRhythm({ minMs: 12000, maxMs: 3000 });
    expect(r.maxMs).toBe(12000);
    const g = resolveHumanRhythm({ partGapMinMs: 6000, partGapMaxMs: 1000 });
    expect(g.partGapMaxMs).toBe(6000);
  });

  it("ignores junk instead of producing NaN waits", () => {
    const r = resolveHumanRhythm({ minMs: "soon", maxMs: -5, maxParts: 0 });
    expect(r.minMs).toBe(HUMAN_RHYTHM_DEFAULTS.minMs);
    expect(r.maxMs).toBe(HUMAN_RHYTHM_DEFAULTS.maxMs);
    expect(r.maxParts).toBe(HUMAN_RHYTHM_DEFAULTS.maxParts);
  });
});

describe("splitIntoParts", () => {
  const rhythm = resolveHumanRhythm({ enabled: true });

  it("splits on a blank line", () => {
    expect(splitIntoParts("היי אדריאן!\n\nמה האירוע?", rhythm)).toEqual([
      "היי אדריאן!",
      "מה האירוע?",
    ]);
  });

  it("keeps single newlines inside one message", () => {
    const text = "היי!\nאני מאיה מפורצ'יני.\nמה האירוע?";
    expect(splitIntoParts(text, rhythm)).toEqual([text]);
  });

  it("never splits a long answer", () => {
    const long = "א".repeat(500);
    expect(splitIntoParts(`${long}\n\n${long}`, rhythm)).toHaveLength(1);
  });

  it("merges the tail so a reply never exceeds maxParts", () => {
    const parts = splitIntoParts("א\n\nב\n\nג\n\nד", rhythm);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe("ג\n\nד");
  });

  it("is inert when splitting is turned off", () => {
    const off = resolveHumanRhythm({ enabled: true, splitParagraphs: false });
    expect(splitIntoParts("א\n\nב", off)).toEqual(["א\n\nב"]);
  });
});

describe("createReplyPacer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits out the target before the first message, then only the gap", async () => {
    const rhythm = resolveHumanRhythm({
      enabled: true,
      minMs: 10000,
      maxMs: 10000,
      partGapMinMs: 3000,
      partGapMaxMs: 3000,
    });
    const pacer = createReplyPacer({ config: cfg, rhythm, messageId: "wamid.1", log });

    let firstDone = false;
    const first = pacer.beforeSend().then(() => {
      firstDone = true;
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(firstDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(firstDone).toBe(true);

    let secondDone = false;
    const second = pacer.beforeSend().then(() => {
      secondDone = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(secondDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    pacer.stop();
  });

  it("does not add to a reply that already took longer than the target", async () => {
    const rhythm = resolveHumanRhythm({ enabled: true, minMs: 5000, maxMs: 5000 });
    const pacer = createReplyPacer({ config: cfg, rhythm, messageId: "wamid.2", log });
    await vi.advanceTimersByTimeAsync(20000);
    let done = false;
    const send = pacer.beforeSend().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await send;
    expect(done).toBe(true);
    pacer.stop();
  });

  it("starts typing after the read pause and refreshes it while waiting", async () => {
    const rhythm = resolveHumanRhythm({ enabled: true, typingAfterMs: 3000 });
    const pacer = createReplyPacer({ config: cfg, rhythm, messageId: "wamid.3", log });
    const fetchMock = globalThis.fetch as any;

    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    pacer.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
