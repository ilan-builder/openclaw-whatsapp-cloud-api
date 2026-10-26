// ---------------------------------------------------------------------------
// One prompt-cache key per agent (PinkLime fork)
//
// OpenClaw sends xAI and OpenAI `prompt_cache_key = <sessionId>:<boundary>`
// when nothing else is set. The provider routes the cache by that key, so the
// FIRST call of every new conversation runs cold: the ~50k-token system prompt
// every conversation shares is cached under some other conversation's key. A
// probe on 26.10.2026 against api.x.ai: same key, different last message =>
// 14,080 of 14,093 prompt tokens cached; a new key => 1,152.
//
// `channels.whatsapp-cloud.promptCacheKey` gives every conversation of this
// agent one key. The prefix they share is then cached once, and each
// conversation's own history still extends it. Empty = OpenClaw's default.
// ---------------------------------------------------------------------------

/** OpenAI's documented limit; OpenClaw truncates its own keys to it too. */
export const PROMPT_CACHE_KEY_MAX = 64;

export function resolvePromptCacheKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, PROMPT_CACHE_KEY_MAX);
}

/** The replyOptions fragment for dispatch: nothing when no key is configured. */
export function promptCacheReplyOptions(key: string): { promptCacheKey?: string } {
  return key ? { promptCacheKey: key } : {};
}
