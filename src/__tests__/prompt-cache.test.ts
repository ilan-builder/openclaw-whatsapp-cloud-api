import { describe, expect, it } from "vitest";
import { PROMPT_CACHE_KEY_MAX, promptCacheReplyOptions, resolvePromptCacheKey } from "../prompt-cache.js";

describe("promptCacheKey", () => {
  it("is off unless a non-empty string is configured", () => {
    expect(resolvePromptCacheKey(undefined)).toBe("");
    expect(resolvePromptCacheKey(42)).toBe("");
    expect(resolvePromptCacheKey("   ")).toBe("");
    expect(promptCacheReplyOptions("")).toEqual({});
  });

  it("passes a configured key through, trimmed and capped", () => {
    expect(resolvePromptCacheKey(" pinklime-bigardens-v1 ")).toBe("pinklime-bigardens-v1");
    expect(resolvePromptCacheKey("x".repeat(100))).toHaveLength(PROMPT_CACHE_KEY_MAX);
    expect(promptCacheReplyOptions("pinklime-bigardens-v1")).toEqual({ promptCacheKey: "pinklime-bigardens-v1" });
  });
});
