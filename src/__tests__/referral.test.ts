import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReferralBody,
  canDeliverReferral,
  claimReferral,
  matchProduct,
  normalizeProducts,
  oneLine,
  readReferralEntry,
  referralSource,
  resolveReferral,
  stateFileName,
  validateEntry,
  writeReferralEntry,
  REFERRAL_OPEN,
  REFERRAL_CLOSE,
  type ReferralConfig,
  type ReferralEntry,
} from "../referral.js";
import { renderFirstReply, resolveFirstReply, HISTORY_OPEN } from "../first-reply.js";
import type { MessageReferral } from "../types.js";

const PEER = "972543343052";

const AD: MessageReferral = {
  source_url: "https://www.instagram.com/p/CxYz/",
  source_id: "120212345678901234",
  source_type: "ad",
  headline: "מטבח חוץ טוסקנה פרו",
  body: "מטבח חוץ יוקרתי עם בר,\nמשלוח והרכבה בכל הארץ.",
  media_type: "image",
  image_url: "https://scontent.cdninstagram.com/v/x.jpg",
  ctwa_clid: "ARBc1",
};

const entryFor = (over: Partial<ReferralEntry> = {}): ReferralEntry => ({
  peer: PEER,
  ts: "2026-09-07T09:00:00.000Z",
  waMessageId: "wamid.AAA",
  referral: AD,
  deliveredAt: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("resolveReferral", () => {
  it("is ON by default and needs no config at all", () => {
    const cfg = resolveReferral(undefined, undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.products).toEqual([]);
    expect(cfg.stateDir.endsWith("/referral")).toBe(true);
    expect(cfg.bodyMaxChars).toBe(300);
    expect(cfg.preamble).toContain("arrived from this ad");
  });

  it("can be switched off and takes an explicit state dir, preamble and body cap", () => {
    const cfg = resolveReferral({
      enabled: false,
      stateDir: "/tmp/x",
      preamble: "  say hi  ",
      bodyMaxChars: 40,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.stateDir).toBe("/tmp/x");
    expect(cfg.preamble).toBe("say hi");
    expect(cfg.bodyMaxChars).toBe(40);
  });

  it("reads the rules from referralProducts, the key a client edits", () => {
    const cfg = resolveReferral(undefined, [
      { match: { headline: "טוסקנה" }, slug: "luxury-outdoor-kitchen-with-bar", name: "מטבח חוץ טוסקנה פרו" },
    ]);
    expect(cfg.products).toHaveLength(1);
    expect(cfg.products[0].slug).toBe("luxury-outdoor-kitchen-with-bar");
  });
});

describe("normalizeProducts", () => {
  it("drops a rule with no recognised matcher — a typo must never become a catch-all", () => {
    expect(normalizeProducts([{ match: { sourceID: "1" }, slug: "s", name: "n" }])).toEqual([]);
    expect(normalizeProducts([{ match: {}, slug: "s", name: "n" }])).toEqual([]);
    expect(normalizeProducts([{ slug: "s", name: "n" }])).toEqual([]);
  });

  it("drops a rule with no slug or no name, and keeps a good one", () => {
    expect(normalizeProducts([{ match: { sourceId: "1" }, name: "n" }])).toEqual([]);
    expect(normalizeProducts([{ match: { sourceId: "1" }, slug: "s" }])).toEqual([]);
    expect(normalizeProducts([{ match: { sourceId: " 1 " }, slug: " s ", name: " n " }])).toEqual([
      { match: { sourceId: "1" }, slug: "s", name: "n" },
    ]);
  });

  it("survives junk", () => {
    expect(normalizeProducts(undefined)).toEqual([]);
    expect(normalizeProducts("nope")).toEqual([]);
    expect(normalizeProducts([null, 3, "x"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ad → product
// ---------------------------------------------------------------------------

describe("matchProduct", () => {
  const rules = (raw: unknown) => resolveReferral(undefined, raw).products;

  it("matches by sourceId, exactly", () => {
    const r = rules([{ match: { sourceId: "120212345678901234" }, slug: "s", name: "n" }]);
    expect(matchProduct(AD, r)?.slug).toBe("s");
    expect(matchProduct({ ...AD, source_id: "999" }, r)).toBeNull();
    // never a prefix
    expect(matchProduct({ ...AD, source_id: "1202123456789012345" }, r)).toBeNull();
  });

  it("matches by a case-insensitive headline regex", () => {
    expect(matchProduct(AD, rules([{ match: { headline: "טוסקנה" }, slug: "s", name: "n" }]))?.slug).toBe("s");
    expect(
      matchProduct({ ...AD, headline: "TOSCANA pro" }, rules([{ match: { headline: "toscana" }, slug: "s", name: "n" }]))
        ?.slug
    ).toBe("s");
    expect(matchProduct(AD, rules([{ match: { headline: "^פרגולה" }, slug: "s", name: "n" }]))).toBeNull();
  });

  it("matches by a body regex", () => {
    expect(matchProduct(AD, rules([{ match: { body: "והרכבה" }, slug: "s", name: "n" }]))?.slug).toBe("s");
    expect(matchProduct(AD, rules([{ match: { body: "ביטוח" }, slug: "s", name: "n" }]))).toBeNull();
  });

  it("ANDs the matchers a rule actually gives", () => {
    const both = rules([{ match: { sourceId: AD.source_id, headline: "טוסקנה" }, slug: "s", name: "n" }]);
    expect(matchProduct(AD, both)?.slug).toBe("s");
    expect(matchProduct({ ...AD, headline: "פרגולה" }, both)).toBeNull();
    expect(matchProduct({ ...AD, source_id: "0" }, both)).toBeNull();
  });

  it("takes the FIRST rule that matches", () => {
    const r = rules([
      { match: { headline: "פרו" }, slug: "first", name: "a" },
      { match: { headline: "טוסקנה" }, slug: "second", name: "b" },
    ]);
    expect(matchProduct(AD, r)?.slug).toBe("first");
  });

  it("is null with no config, no referral, or a broken regex", () => {
    expect(matchProduct(AD, [])).toBeNull();
    expect(matchProduct(AD, rules(undefined))).toBeNull();
    expect(matchProduct(undefined, rules([{ match: { headline: "x" }, slug: "s", name: "n" }]))).toBeNull();
    expect(matchProduct(AD, rules([{ match: { headline: "([" }, slug: "s", name: "n" }]))).toBeNull();
  });

  it("never matches a field the ad does not carry", () => {
    const r = rules([{ match: { headline: "טוסקנה" }, slug: "s", name: "n" }]);
    expect(matchProduct({ source_id: "1" }, r)).toBeNull();
  });
});

describe("referralSource", () => {
  it("reads the source_url first", () => {
    expect(referralSource({ source_url: "https://www.instagram.com/p/x" })).toBe("instagram");
    expect(referralSource({ source_url: "https://www.facebook.com/1/posts/2" })).toBe("facebook");
    expect(referralSource({ source_url: "https://fb.me/abc" })).toBe("facebook");
  });

  it("falls back to the creative urls, then to meta", () => {
    expect(referralSource({ video_url: "https://scontent.cdninstagram.com/v.mp4" })).toBe("instagram");
    expect(referralSource({ image_url: "https://scontent.xx.fbcdn.net/i.jpg" })).toBe("facebook");
    expect(referralSource({ source_id: "1" })).toBe("meta");
    expect(referralSource(undefined)).toBe("meta");
  });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe("stateFileName", () => {
  it("never lets a peer escape the directory", () => {
    expect(stateFileName(PEER)).toBe(`${PEER}.json`);
    expect(stateFileName("../../etc/passwd")).toBe("______etc_passwd.json");
    expect(stateFileName("")).toBe("unknown.json");
  });
});

describe("validateEntry", () => {
  it("accepts a well-formed file", () => {
    const ok = validateEntry(entryFor({ product: { slug: "s", name: "n" } }), PEER);
    expect(ok?.referral.source_id).toBe(AD.source_id);
    expect(ok?.product?.slug).toBe("s");
  });

  it("refuses another peer's file, an empty referral and junk", () => {
    expect(validateEntry(entryFor({ peer: "972500000000" }), PEER)).toBeNull();
    expect(validateEntry({ peer: PEER, referral: {} }, PEER)).toBeNull();
    expect(validateEntry({ peer: PEER }, PEER)).toBeNull();
    expect(validateEntry(null, PEER)).toBeNull();
    expect(validateEntry("x", PEER)).toBeNull();
  });

  it("drops a half-written product instead of guessing one", () => {
    expect(validateEntry(entryFor({ product: { slug: "s" } as any }), PEER)?.product).toBeUndefined();
  });
});

describe("persistence", () => {
  let dir: string;
  let cfg: ReferralConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "referral-"));
    cfg = resolveReferral({ stateDir: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes an entry and reads it back", async () => {
    await writeReferralEntry(cfg, entryFor());
    const back = await readReferralEntry(cfg, PEER);
    expect(back?.referral.headline).toBe(AD.headline);
    expect(back?.deliveredAt).toBeNull();
  });

  it("leaves no temp file behind", async () => {
    await writeReferralEntry(cfg, entryFor());
    expect(await readdir(dir)).toEqual([`${PEER}.json`]);
  });

  it("a newer click overwrites an older undelivered one", async () => {
    await writeReferralEntry(cfg, entryFor());
    await writeReferralEntry(
      cfg,
      entryFor({
        waMessageId: "wamid.BBB",
        referral: { ...AD, source_id: "999", headline: "פרגולה" },
        product: { slug: "pergola", name: "פרגולה" },
      })
    );
    const back = await readReferralEntry(cfg, PEER);
    expect(back?.referral.source_id).toBe("999");
    expect(back?.product?.slug).toBe("pergola");
    expect(await readdir(dir)).toEqual([`${PEER}.json`]);
  });

  it("reads nothing for a peer who arrived from no ad", async () => {
    expect(await readReferralEntry(cfg, "972500000000")).toBeNull();
  });

  it("claims exactly once — the rename IS the claim", async () => {
    await writeReferralEntry(cfg, entryFor());
    const first = await claimReferral(cfg, PEER);
    expect(first.entry?.referral.source_id).toBe(AD.source_id);
    expect(first.consumed).toBe(true);
    expect(first.entry?.deliveredAt).toBeTruthy();

    const second = await claimReferral(cfg, PEER);
    expect(second.entry).toBeNull();
    expect(second.consumed).toBe(false);
  });

  it("keeps the claimed copy as the record of what the model was told", async () => {
    await writeReferralEntry(cfg, entryFor());
    await claimReferral(cfg, PEER);
    const saved = JSON.parse(await readFile(join(dir, `${PEER}.delivered.json`), "utf-8"));
    expect(saved.deliveredAt).toBeTruthy();
    expect(saved.referral.source_id).toBe(AD.source_id);
  });

  it("consumes a malformed file instead of retrying it forever", async () => {
    await writeFile(join(dir, `${PEER}.json`), "{ not json", "utf-8");
    const claim = await claimReferral(cfg, PEER);
    expect(claim.entry).toBeNull();
    expect(claim.consumed).toBe(true);
    expect(claim.malformed).toBe(true);
    expect(await claimReferral(cfg, PEER)).toEqual({ entry: null, consumed: false });
  });

  it("a click after a delivery is claimable again", async () => {
    await writeReferralEntry(cfg, entryFor());
    await claimReferral(cfg, PEER);
    await writeReferralEntry(cfg, entryFor({ referral: { ...AD, source_id: "777" } }));
    expect((await claimReferral(cfg, PEER)).entry?.referral.source_id).toBe("777");
  });
});

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

describe("oneLine", () => {
  it("collapses newlines and trims to the cap", () => {
    expect(oneLine("a\n b   c ", 100)).toBe("a b c");
    expect(oneLine("abcdef", 3)).toBe("abc…");
    expect(oneLine(undefined, 10)).toBe("");
  });
});

describe("buildReferralBody", () => {
  const cfg = resolveReferral(undefined);

  it("renders the ad, then the message", () => {
    const body = buildReferralBody(entryFor(), "יש לכם משלוח?", cfg);
    const lines = body.split("\n");
    expect(lines[0]).toBe(REFERRAL_OPEN);
    expect(lines[1]).toContain("arrived from this ad");
    expect(lines).toContain("source: instagram");
    expect(lines).toContain("type: ad");
    expect(lines).toContain(`ad_id: ${AD.source_id}`);
    expect(lines).toContain("headline: מטבח חוץ טוסקנה פרו");
    expect(lines).toContain("body: מטבח חוץ יוקרתי עם בר, משלוח והרכבה בכל הארץ.");
    expect(lines[lines.length - 2]).toBe(REFERRAL_CLOSE);
    expect(lines[lines.length - 1]).toBe("יש לכם משלוח?");
    expect(body).not.toContain("product:");
  });

  it("names the product when one matched", () => {
    const body = buildReferralBody(
      entryFor({ product: { slug: "luxury-outdoor-kitchen-with-bar", name: "מטבח חוץ טוסקנה פרו" } }),
      "היי",
      cfg
    );
    expect(body).toContain("product: luxury-outdoor-kitchen-with-bar | מטבח חוץ טוסקנה פרו");
  });

  it("omits every field the ad did not carry, and defaults the type", () => {
    const body = buildReferralBody(entryFor({ referral: { ctwa_clid: "x" } }), "היי", cfg);
    expect(body).toContain("source: meta");
    expect(body).toContain("type: ad");
    expect(body).not.toContain("ad_id:");
    expect(body).not.toContain("headline:");
    expect(body).not.toContain("body:");
  });

  it("trims a long body and keeps it on one line", () => {
    const long = `${"א".repeat(500)}\nעוד שורה`;
    const body = buildReferralBody(entryFor({ referral: { ...AD, body: long } }), "היי", cfg);
    const line = body.split("\n").find((l) => l.startsWith("body: "))!;
    expect(line.length).toBe("body: ".length + 300 + 1); // + the ellipsis
    expect(line.endsWith("…")).toBe(true);
  });

  it("honours a client's own body cap", () => {
    const small = resolveReferral({ bodyMaxChars: 10 });
    const line = buildReferralBody(entryFor(), "היי", small)
      .split("\n")
      .find((l) => l.startsWith("body: "))!;
    expect(line).toBe("body: מטבח חוץ י…"); // 10 characters, then the ellipsis
  });

  it("goes in FRONT of a history block — the click came first", () => {
    const base = `${HISTORY_OPEN}\npreamble\n<<<user t>>>\nהיי\n[/PINKLIME_HISTORY]\nעוד שאלה`;
    const body = buildReferralBody(entryFor(), base, cfg);
    expect(body.indexOf(REFERRAL_OPEN)).toBe(0);
    expect(body.indexOf(REFERRAL_CLOSE)).toBeLessThan(body.indexOf(HISTORY_OPEN));
    expect(body.endsWith("עוד שאלה")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Who may spend the one delivery
// ---------------------------------------------------------------------------

describe("canDeliverReferral", () => {
  const cfg = resolveReferral(undefined);

  it("allows a normal text and a media message", () => {
    expect(canDeliverReferral(cfg, { type: "text", text: "היי" })).toBe(true);
    expect(canDeliverReferral(cfg, { type: "image", text: "[📷 Image]" })).toBe(true);
  });

  it("skips a slash command — it must reach the parser untouched", () => {
    expect(canDeliverReferral(cfg, { type: "text", text: "/new" })).toBe(false);
    expect(canDeliverReferral(cfg, { type: "text", text: "  /reset now" })).toBe(false);
  });

  it("skips a Flow completion and anything at all when switched off", () => {
    expect(canDeliverReferral(cfg, { type: "interactive", text: "x", flowReply: { responseJson: "{}" } })).toBe(false);
    expect(canDeliverReferral(resolveReferral({ enabled: false }), { type: "text", text: "היי" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivered exactly once, in both inbound paths
// ---------------------------------------------------------------------------

describe("delivery, end to end", () => {
  let dir: string;
  let cfg: ReferralConfig;

  // The two steps index.ts runs per inbound message, in the same order.
  const persist = (referral: MessageReferral, waMessageId: string) =>
    writeReferralEntry(cfg, {
      peer: PEER,
      ts: new Date().toISOString(),
      waMessageId,
      referral,
      ...(matchProduct(referral, cfg.products) ? { product: matchProduct(referral, cfg.products)! } : {}),
      deliveredAt: null,
    });

  const deliver = async (message: { type: string; text: string; flowReply?: unknown }) => {
    if (!canDeliverReferral(cfg, message)) return message.text;
    const claim = await claimReferral(cfg, PEER);
    return claim.entry ? buildReferralBody(claim.entry, message.text, cfg) : message.text;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "referral-"));
    cfg = resolveReferral({ stateDir: dir }, [
      { match: { headline: "טוסקנה" }, slug: "luxury-outdoor-kitchen-with-bar", name: "מטבח חוץ טוסקנה פרו" },
    ]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the canned reply fired: the block rides the customer's SECOND message", async () => {
    // Message 1 — the ad opener. The canned reply answers it and index.ts
    // returns BEFORE the delivery step, so nothing is claimed.
    await persist(AD, "wamid.1");

    // Message 2 — the first one that reaches the model.
    const body = await deliver({ type: "text", text: "יש לכם משלוח?" });
    expect(body).toContain(REFERRAL_OPEN);
    expect(body).toContain("product: luxury-outdoor-kitchen-with-bar | מטבח חוץ טוסקנה פרו");
    expect(body.endsWith("יש לכם משלוח?")).toBe(true);

    // Message 3 — never again.
    expect(await deliver({ type: "text", text: "ומה המחיר?" })).toBe("ומה המחיר?");
  });

  it("the canned reply did not fire: the block rides the SAME message", async () => {
    await persist(AD, "wamid.1");
    const body = await deliver({ type: "text", text: "היי, אשמח לקבל פרטים על הטוסקנה" });
    expect(body).toContain(REFERRAL_OPEN);
    expect(await deliver({ type: "text", text: "?" })).toBe("?");
  });

  it("a slash command in between does not spend the delivery", async () => {
    await persist(AD, "wamid.1");
    expect(await deliver({ type: "text", text: "/status" })).toBe("/status");
    expect(await deliver({ type: "text", text: "היי" })).toContain(REFERRAL_OPEN);
  });

  it("a peer who arrived from no ad gets the bare text", async () => {
    expect(await deliver({ type: "text", text: "היי" })).toBe("היי");
  });

  it("a second click before the first was delivered wins", async () => {
    await persist(AD, "wamid.1");
    await persist({ ...AD, source_id: "888", headline: "פרגולה" }, "wamid.2");
    const body = await deliver({ type: "text", text: "היי" });
    expect(body).toContain("ad_id: 888");
    expect(body).not.toContain("product:"); // "פרגולה" matches no rule
  });
});

// ---------------------------------------------------------------------------
// The product-aware canned first reply
// ---------------------------------------------------------------------------

describe("renderFirstReply with a matched product", () => {
  const product = { slug: "luxury-outdoor-kitchen-with-bar", name: "מטבח חוץ טוסקנה פרו" };

  it("uses referralText when the ad matched a product", () => {
    const cfg = resolveFirstReply({
      enabled: true,
      match: ["היי"],
      text: "היי{name_comma} אני נועה. מה מחפשים?",
      referralText: "היי{name_comma} אני נועה. ראיתי שהגעתם מ{product} — רוצים פרטים עליו?",
    });
    expect(renderFirstReply(cfg, "רונית", product)).toBe(
      "היי רונית, אני נועה. ראיתי שהגעתם ממטבח חוץ טוסקנה פרו — רוצים פרטים עליו?"
    );
    // no product → the normal text, untouched
    expect(renderFirstReply(cfg, "רונית", null)).toBe("היי רונית, אני נועה. מה מחפשים?");
    expect(renderFirstReply(cfg, "רונית")).toBe("היי רונית, אני נועה. מה מחפשים?");
  });

  it("falls back to the normal texts when no referralText is configured", () => {
    const cfg = resolveFirstReply({ enabled: true, match: ["היי"], text: "היי, מה מחפשים?" });
    expect(renderFirstReply(cfg, null, product)).toBe("היי, מה מחפשים?");
  });

  it("defaults referralTextNoName to referralText, and uses it for a nameless visitor", () => {
    const cfg = resolveFirstReply({
      enabled: true,
      match: ["היי"],
      text: "t",
      referralText: "שלום{name_comma} לגבי {product}?",
      referralTextNoName: "שלום, לגבי {product}?",
    });
    expect(cfg.referralTextNoName).toBe("שלום, לגבי {product}?");
    expect(renderFirstReply(cfg, null, product)).toBe("שלום, לגבי מטבח חוץ טוסקנה פרו?");
    expect(resolveFirstReply({ referralText: "a" }).referralTextNoName).toBe("a");
  });

  it("leaves {product} empty rather than printing a placeholder", () => {
    const cfg = resolveFirstReply({ enabled: true, match: ["היי"], text: "על {product}?" });
    expect(renderFirstReply(cfg, null, null)).toBe("על ?");
  });
});
