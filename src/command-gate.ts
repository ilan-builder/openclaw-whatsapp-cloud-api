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
