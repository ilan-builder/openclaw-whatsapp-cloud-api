import { describe, it, expect } from "vitest";
import { extractDirectives } from "../directives.js";

describe("extractDirectives", () => {
  it("passes plain text through untouched", () => {
    expect(extractDirectives("שלום! איך אפשר לעזור?")).toEqual({ text: "שלום! איך אפשר לעזור?", flows: [] });
  });

  it("extracts a trailing FLOW directive and strips it", () => {
    const out = extractDirectives("בוא נקבע פגישה 📅\nFLOW: netanya-booking");
    expect(out.text).toBe("בוא נקבע פגישה 📅");
    expect(out.flows).toEqual(["netanya-booking"]);
  });

  it("handles a directive-only reply (empty remaining text)", () => {
    const out = extractDirectives("FLOW: netanya-booking");
    expect(out.text).toBe("");
    expect(out.flows).toEqual(["netanya-booking"]);
  });

  it("does not treat FLOW mid-sentence as a directive", () => {
    const out = extractDirectives("the FLOW: of water");
    expect(out.flows).toEqual([]);
    expect(out.text).toBe("the FLOW: of water");
  });
});
