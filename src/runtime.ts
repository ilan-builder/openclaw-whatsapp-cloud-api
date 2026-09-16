// ---------------------------------------------------------------------------
// Runtime accessor — stores the PluginRuntime reference provided by OpenClaw
// ---------------------------------------------------------------------------

// PluginRuntime is provided by OpenClaw at load time via api.runtime.
// We store it here so all modules can access it without circular deps.

let runtime: any = null;

export function setWhatsAppCloudRuntime(next: any): void {
  runtime = next;
}

export function getWhatsAppCloudRuntime(): any {
  if (!runtime) {
    throw new Error(
      "WhatsApp Cloud runtime not initialized — plugin not loaded correctly"
    );
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Config access — ONE shim for two OpenClaw generations (PinkLime fork)
//
// `runtime.config.loadConfig()` and `runtime.config.writeConfigFile()` were
// DEPRECATED shims in OpenClaw 2026.7.x and were REMOVED in 2026.9.x. On
// 2026.9.4 `runtime.config` is `{ current, mutateConfigFile, replaceConfigFile }`,
// so every call to the old names threw
//
//     TypeError: runtime.config.loadConfig is not a function
//
// and on the inbound path that killed EVERY incoming WhatsApp message while the
// gateway still reported itself healthy.
//
// The replacements are exactly what 2026.7.x's own deprecated shims delegated to
// (verbatim from /app/dist/plugins/runtime/index.js at 2026.7.1):
//
//     loadConfig: () => { warnDeprecatedConfigApiOnce(...); return getRuntimeConfig(); }
//     writeConfigFile: async (cfg, options) => { warnDeprecatedConfigApiOnce(...);
//       await replaceConfigFile({ nextConfig: cfg,
//         afterWrite: options?.afterWrite ?? { mode: "auto" }, writeOptions: options }); }
//
// so preferring the new names is not a behaviour change, it is calling the same
// code one layer down.
//
// These probe for the CAPABILITY, never for a version string: one build of this
// plugin has to work on the image the fleet runs today and on the image it is
// upgrading to, and a rollback must not need a different plugin commit.
// ---------------------------------------------------------------------------

/**
 * Returns the live OpenClaw config.
 *
 * 2026.9.x: `config.current()` — synchronous, reads the runtime snapshot.
 * 2026.7.x: `config.current()` too (it exists there as well, and `loadConfig()`
 * was only a deprecation wrapper around it). `loadConfig()` is kept as the
 * fallback for any older runtime that predates `current`.
 */
export async function loadRuntimeConfig(rt?: any): Promise<any> {
  const cfgApi = (rt ?? getWhatsAppCloudRuntime())?.config;
  if (!cfgApi) {
    throw new Error("WhatsApp Cloud: runtime.config is unavailable");
  }
  if (typeof cfgApi.current === "function") {
    return await cfgApi.current();
  }
  if (typeof cfgApi.loadConfig === "function") {
    return await cfgApi.loadConfig();
  }
  throw new Error(
    "WhatsApp Cloud: this OpenClaw runtime exposes neither config.current() nor config.loadConfig()"
  );
}

/**
 * Replaces the whole OpenClaw config file.
 *
 * 2026.9.x: `config.replaceConfigFile({ nextConfig, afterWrite })`.
 * 2026.7.x: the same function, reachable either directly or through the
 * deprecated `writeConfigFile(cfg)` wrapper.
 */
export async function writeRuntimeConfig(nextConfig: any, rt?: any): Promise<void> {
  const cfgApi = (rt ?? getWhatsAppCloudRuntime())?.config;
  if (!cfgApi) {
    throw new Error("WhatsApp Cloud: runtime.config is unavailable");
  }
  if (typeof cfgApi.replaceConfigFile === "function") {
    await cfgApi.replaceConfigFile({ nextConfig, afterWrite: { mode: "auto" } });
    return;
  }
  if (typeof cfgApi.writeConfigFile === "function") {
    await cfgApi.writeConfigFile(nextConfig);
    return;
  }
  throw new Error(
    "WhatsApp Cloud: this OpenClaw runtime exposes neither config.replaceConfigFile() nor config.writeConfigFile()"
  );
}
