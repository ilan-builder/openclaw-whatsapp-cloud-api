/**
 * Unauthorized slash commands (PinkLime fork)
 *
 * A customer who types "/new" (or any "/command") is not on `commands.allowFrom`,
 * so OpenClaw ignores the command on purpose and returns no reply. Since
 * 2026.9.x the runtime then sends its direct-chat no-visible-reply fallback,
 *   "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. ..."
 * to the customer. So the channel drops the turn itself, before dispatch: the
 * runtime never sees it, and nothing is sent back.
 *
 * Whoever IS on `commands.allowFrom` (or every peer, when the list is absent or
 * empty, mirroring commandsAllowedFrom) passes through untouched, so an
 * operator's "/new" still resets the session. Normal text is never touched.
 */
import { commandsAllowedFrom } from "./first-reply.js";

/** A slash command: "/" followed by a letter, e.g. "/new", "/reset", "/status". */
export function isSlashCommand(text: unknown): boolean {
  return /^\/[A-Za-z]/.test(String(text ?? "").trimStart());
}

/** True when this inbound message must be dropped before it reaches OpenClaw. */
export function shouldDropUnauthorizedCommand(
  cfg: any,
  message: { type?: string; text?: string; from: string },
  channel = "whatsapp-cloud"
): boolean {
  if (message.type !== "text") return false;
  if (!isSlashCommand(message.text)) return false;
  return !commandsAllowedFrom(cfg, message.from, channel);
}

// ---------------------------------------------------------------------------
// Runtime recovery notices (OpenClaw 2026.10.x)
// ---------------------------------------------------------------------------

/**
 * English operator notices the OpenClaw 2026.10 gateway sends on its own after
 * a restart (src/agents/main-session-recovery, src/channels/turn/
 * pending-delivery-notice in openclaw@2026.10.10). They go out through this
 * channel's outbound adapter like any reply:
 *   - the restart-recovery tombstone: "I couldn't continue this session after a
 *     gateway restart: … in other channels, use /new or /reset to start a
 *     replacement session."
 *   - the pending-delivery notice: "I couldn’t confirm whether my previous
 *     reply reached this chat, so I won’t resend it automatically. …"
 *   - the resume notice, sent when an interrupted turn is re-run after an
 *     unclean restart: "I'm continuing your interrupted request now (the
 *     gateway has just restarted). …" (seen live on 2026.10.10; the re-run
 *     reply itself still goes out normally)
 *   - the could-not-resume notice: "This interrupted turn could not resume
 *     after the Gateway restarted: …"
 * A customer can't act on any of them: the /new hint names a command this channel
 * drops for them (above), and both are English operator text. They still reach
 * whoever is on `commands.allowFrom`.
 */
const RUNTIME_NOTICE_PATTERNS: RegExp[] = [
  /^I couldn['’]t continue this session after a gateway restart:/,
  /^I couldn['’]t confirm whether my previous reply reached this chat\b/,
  /\buse \/new or \/reset\b/,
  /^I['’]m continuing your interrupted request now\b/,
  /^This interrupted turn could not resume after the Gateway restarted\b/,
];

/** True when the text is one of the gateway's own recovery notices. */
export function isRuntimeRecoveryNotice(text: unknown): boolean {
  const s = String(text ?? "").trim();
  return s.length > 0 && RUNTIME_NOTICE_PATTERNS.some((re) => re.test(s));
}

/** True when an outbound text must not be sent to this peer. */
export function shouldDropRuntimeNotice(cfg: any, to: string, text: unknown, channel = "whatsapp-cloud"): boolean {
  if (!isRuntimeRecoveryNotice(text)) return false;
  return !commandsAllowedFrom(cfg, to, channel);
}
