import { describe, it, expect } from "vitest";
import { buildInboundSessionKey, resolveDefaultAgentId } from "../index.js";

describe("resolveDefaultAgentId", () => {
  it("picks the agent flagged default", () => {
    const cfg = {
      agents: {
        list: [
          { id: "other", default: false },
          { id: "main", default: true, name: "Maya (WhatsApp)" },
        ],
      },
    };
    expect(resolveDefaultAgentId(cfg)).toBe("main");
  });

  it("falls back to the first agent when none is flagged default", () => {
    const cfg = { agents: { list: [{ id: "solo" }, { id: "other" }] } };
    expect(resolveDefaultAgentId(cfg)).toBe("solo");
  });

  it("falls back to 'main' when the config has no agents", () => {
    expect(resolveDefaultAgentId({})).toBe("main");
    expect(resolveDefaultAgentId(undefined)).toBe("main");
    expect(resolveDefaultAgentId({ agents: {} })).toBe("main");
    expect(resolveDefaultAgentId({ agents: { list: [] } })).toBe("main");
  });
});

describe("buildInboundSessionKey", () => {
  const cfg = { agents: { list: [{ id: "main", default: true }] } };

  it("builds the fully canonical agent-prefixed key", () => {
    expect(buildInboundSessionKey(cfg, "972543343052")).toBe(
      "agent:main:whatsapp-cloud:direct:972543343052"
    );
  });

  it("never emits the bare, un-prefixed key", () => {
    // Regression guard: the bare form twins the session — inbound turns ran
    // under `whatsapp-cloud:direct:<peer>` while the store canonicalised
    // everything else to `agent:main:whatsapp-cloud:direct:<peer>`, so the
    // agent kept re-greeting from an empty history.
    const key = buildInboundSessionKey(cfg, "972543343052");
    expect(key).not.toBe("whatsapp-cloud:direct:972543343052");
    expect(key.startsWith("agent:")).toBe(true);
  });

  it("has exactly five colon-separated segments", () => {
    expect(buildInboundSessionKey(cfg, "972543343052").split(":")).toEqual([
      "agent",
      "main",
      "whatsapp-cloud",
      "direct",
      "972543343052",
    ]);
  });

  it("uses the configured default agent id, not a hardcoded 'main'", () => {
    const custom = { agents: { list: [{ id: "sales", default: true }] } };
    expect(buildInboundSessionKey(custom, "972500000000")).toBe(
      "agent:sales:whatsapp-cloud:direct:972500000000"
    );
  });
});
