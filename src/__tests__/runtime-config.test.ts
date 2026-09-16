import { describe, it, expect, beforeEach } from "vitest";
import {
  setWhatsAppCloudRuntime,
  getWhatsAppCloudRuntime,
  loadRuntimeConfig,
  writeRuntimeConfig,
} from "../runtime.js";

// ---------------------------------------------------------------------------
// ONE plugin build, two OpenClaw generations.
//
// 2026.7.x exposed config.{current,mutateConfigFile,replaceConfigFile,
// loadConfig,writeConfigFile} — the last two DEPRECATED wrappers.
// 2026.9.x REMOVED the last two. Calling them threw
// "TypeError: runtime.config.loadConfig is not a function" on the inbound path,
// which killed every incoming WhatsApp message while the gateway still
// reported healthy. These tests pin the capability probe so a future OpenClaw
// bump cannot re-open that outage silently.
// ---------------------------------------------------------------------------

/** The `runtime.config` shape OpenClaw 2026.9.4 really hands a plugin. */
function runtime_2026_9_x(sink: any[]) {
  return {
    config: {
      current: () => ({ channels: { "whatsapp-cloud": { enabled: true } }, via: "current" }),
      mutateConfigFile: async () => {
        throw new Error("mutateConfigFile must not be used for a whole-config replace");
      },
      replaceConfigFile: async (params: any) => {
        sink.push({ api: "replaceConfigFile", params });
      },
    },
  };
}

/** The `runtime.config` shape OpenClaw 2026.7.1-2 hands a plugin. */
function runtime_2026_7_x(sink: any[]) {
  const nine = runtime_2026_9_x(sink).config;
  return {
    config: {
      ...nine,
      loadConfig: () => ({ channels: {}, via: "loadConfig" }),
      writeConfigFile: async (cfg: any) => {
        sink.push({ api: "writeConfigFile", cfg });
      },
    },
  };
}

/** A hypothetical runtime that only has the OLD names (pre-`current`). */
function runtime_legacy_only(sink: any[]) {
  return {
    config: {
      loadConfig: () => ({ channels: {}, via: "loadConfig" }),
      writeConfigFile: async (cfg: any) => {
        sink.push({ api: "writeConfigFile", cfg });
      },
    },
  };
}

describe("runtime config compat shim", () => {
  beforeEach(() => setWhatsAppCloudRuntime(null));

  it("reads the config on OpenClaw 2026.9.x, where loadConfig is gone", async () => {
    const rt = runtime_2026_9_x([]);
    expect(rt.config).not.toHaveProperty("loadConfig");
    const cfg = await loadRuntimeConfig(rt);
    expect(cfg.via).toBe("current");
  });

  it("prefers current() on 2026.7.x too, so one build behaves identically", async () => {
    const cfg = await loadRuntimeConfig(runtime_2026_7_x([]));
    expect(cfg.via).toBe("current");
  });

  it("falls back to loadConfig() on a runtime that predates current()", async () => {
    const cfg = await loadRuntimeConfig(runtime_legacy_only([]));
    expect(cfg.via).toBe("loadConfig");
  });

  it("writes through replaceConfigFile with afterWrite auto on 2026.9.x", async () => {
    const sink: any[] = [];
    await writeRuntimeConfig({ channels: { a: 1 } }, runtime_2026_9_x(sink));
    expect(sink).toEqual([
      {
        api: "replaceConfigFile",
        params: { nextConfig: { channels: { a: 1 } }, afterWrite: { mode: "auto" } },
      },
    ]);
  });

  it("falls back to writeConfigFile on a runtime that has only that", async () => {
    const sink: any[] = [];
    await writeRuntimeConfig({ channels: { a: 1 } }, runtime_legacy_only(sink));
    expect(sink).toEqual([{ api: "writeConfigFile", cfg: { channels: { a: 1 } } }]);
  });

  it("uses the stored runtime when no explicit one is passed", async () => {
    const sink: any[] = [];
    setWhatsAppCloudRuntime(runtime_2026_9_x(sink));
    expect((await loadRuntimeConfig()).via).toBe("current");
    await writeRuntimeConfig({ x: 1 });
    expect(sink[0].api).toBe("replaceConfigFile");
    expect(getWhatsAppCloudRuntime()).toBeTruthy();
  });

  it("names both APIs when a runtime offers neither, instead of a bare TypeError", async () => {
    const empty = { config: {} };
    await expect(loadRuntimeConfig(empty)).rejects.toThrow(
      /neither config\.current\(\) nor config\.loadConfig\(\)/
    );
    await expect(writeRuntimeConfig({}, empty)).rejects.toThrow(
      /neither config\.replaceConfigFile\(\) nor config\.writeConfigFile\(\)/
    );
  });

  it("says so when runtime.config itself is missing", async () => {
    await expect(loadRuntimeConfig({})).rejects.toThrow(/runtime\.config is unavailable/);
    await expect(writeRuntimeConfig({}, {})).rejects.toThrow(/runtime\.config is unavailable/);
  });
});
