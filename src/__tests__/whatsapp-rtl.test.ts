import { describe, expect, it } from "vitest";
import { RLM, ensureWhatsAppRtl, isPredominantlyHebrew, stripRtlMarks } from "../whatsapp-rtl.js";
import { hebrewGreetingName } from "../hebrew-name.js";

const heStart = "שלום Ilan, כאן מיכל, היועצת הדיגיטלית של המכללה האקדמית נתניה";
const heEnd = "יש אצלנו מכינה קדם-אקדמית שתעזור לך להשלים בגרויות, Ilan";
const heLead = "Ilan, יש אצלנו מכינה קדם-אקדמית";
const english = "Hello Ilan, how can I help you today?";
const url = "https://nac-api.lemnaid.com/s/m/972543343052/mba";
const phone = "054-3343052";

describe("ensureWhatsAppRtl", () => {
  it("prefixes a Hebrew line with RLM and marks a trailing Latin name", () => {
    const start = ensureWhatsAppRtl(heStart);
    expect(start.startsWith(RLM)).toBe(true);
    expect(start.startsWith(RLM + RLM)).toBe(false);
    const end = ensureWhatsAppRtl(heEnd);
    expect(end.startsWith(RLM)).toBe(true);
    expect(end.endsWith("Ilan" + RLM)).toBe(true);
    expect(ensureWhatsAppRtl(heLead)).toBe(`${RLM}Ilan,${RLM} יש אצלנו מכינה קדם-אקדמית`);
  });

  it("is idempotent and leaves English, URL lines and phones alone", () => {
    for (const sample of [heStart, heEnd, heLead, `${heStart}\n${heEnd}`]) {
      const once = ensureWhatsAppRtl(sample);
      expect(ensureWhatsAppRtl(once)).toBe(once);
    }
    expect(ensureWhatsAppRtl(english)).toBe(english);
    expect(ensureWhatsAppRtl(url)).toBe(url);
    const withUrl = `אפשר לתאם כאן:\n${url}`;
    const [first, second] = ensureWhatsAppRtl(withUrl).split("\n");
    expect(first.startsWith(RLM)).toBe(true);
    expect(second).toBe(url);
    const inline = `לפרטים: ${url}`;
    const marked = ensureWhatsAppRtl(inline);
    expect(marked.startsWith(RLM)).toBe(true);
    expect(marked.endsWith(url)).toBe(true);
    expect(marked.includes(url + RLM)).toBe(false);
    const withPhone = `אפשר להתקשר אלינו ב-${phone}`;
    expect(ensureWhatsAppRtl(withPhone).endsWith(phone)).toBe(true);
    expect(isPredominantlyHebrew(english, { locale: "he" })).toBe(false);
    expect(stripRtlMarks(ensureWhatsAppRtl(heEnd))).toBe(heEnd);
  });
});

describe("hebrewGreetingName", () => {
  it("transliterates Ilan and David, and passes Hebrew through", () => {
    expect(hebrewGreetingName("Ilan")).toBe("אילן");
    expect(hebrewGreetingName("David")).toBe("דוד");
    expect(hebrewGreetingName("אילן")).toBe("אילן");
    expect(hebrewGreetingName("נועה כהן")).toBe("נועה");
  });

  it("omits a name that is not a safe first name spelling", () => {
    expect(hebrewGreetingName("")).toBeNull();
    expect(hebrewGreetingName(null)).toBeNull();
    expect(hebrewGreetingName("972543343052")).toBeNull();
    expect(hebrewGreetingName("✨")).toBeNull();
  });
});
