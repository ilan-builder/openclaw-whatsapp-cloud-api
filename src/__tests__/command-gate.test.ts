import { describe, expect, it, vi } from "vitest";
import {
  isRuntimeRecoveryNotice,
  isSlashCommand,
  shouldDropRuntimeNotice,
  shouldDropUnauthorizedCommand,
} from "../command-gate.js";

const OPERATOR = "972543343052";
const CUSTOMER = "972501111111";
const cfg = { commands: { allowFrom: { "whatsapp-cloud": [OPERATOR, "+972-50-721-6963"] } } };
const text = (from: string, body: string) => ({ type: "text", text: body, from });

/** The handler's contract: a dropped message is never dispatched. */
function handle(c: any, message: any, dispatch: (m: any) => void) {
  if (shouldDropUnauthorizedCommand(c, message)) return;
  dispatch(message);
}

describe("isSlashCommand", () => {
  it("matches command-shaped text", () => {
    expect(isSlashCommand("/new")).toBe(true);
    expect(isSlashCommand("  /reset please")).toBe(true);
    expect(isSlashCommand("/status")).toBe(true);
  });
  it("leaves ordinary text alone", () => {
    expect(isSlashCommand("היי")).toBe(false);
    expect(isSlashCommand("1/2 שנה")).toBe(false);
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("/ 5")).toBe(false);
    expect(isSlashCommand(undefined)).toBe(false);
  });
});

describe("shouldDropUnauthorizedCommand", () => {
  it("drops /new from a sender not on commands.allowFrom — no dispatch", () => {
    const dispatch = vi.fn();
    handle(cfg, text(CUSTOMER, "/new"), dispatch);
    handle(cfg, text(CUSTOMER, "/reset"), dispatch);
    handle(cfg, text(CUSTOMER, "/status"), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes /new from an allowed sender through, so the reset still happens", () => {
    const dispatch = vi.fn();
    handle(cfg, text(OPERATOR, "/new"), dispatch);
    handle(cfg, text("972507216963", "/new"), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].text).toBe("/new");
  });

  it("passes normal text from an unauthorized sender through", () => {
    const dispatch = vi.fn();
    handle(cfg, text(CUSTOMER, "מה המחיר של שנת לימודים?"), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never touches non-text messages", () => {
    expect(shouldDropUnauthorizedCommand(cfg, { type: "image", text: "/new", from: CUSTOMER })).toBe(false);
  });

  it("does not restrict when no allowFrom list exists for the channel", () => {
    expect(shouldDropUnauthorizedCommand({}, text(CUSTOMER, "/new"))).toBe(false);
  });
});

describe("runtime recovery notices (OpenClaw 2026.10)", () => {
  // Verbatim from openclaw@2026.10.10 dist (main-session-restart-recovery, execution).
  const TOMBSTONE =
    "I couldn't continue this session after a gateway restart: the run could not be resumed. Your transcript is safe. In WebChat, use Resume in new session to continue it; in other channels, use /new or /reset to start a replacement session.";
  const PENDING =
    "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

  it("recognises both notices and nothing a bot would normally say", () => {
    expect(isRuntimeRecoveryNotice(TOMBSTONE)).toBe(true);
    expect(isRuntimeRecoveryNotice(PENDING)).toBe(true);
    expect(isRuntimeRecoveryNotice("שלום! איך אפשר לעזור?")).toBe(false);
    expect(isRuntimeRecoveryNotice("Use /new to start over")).toBe(false);
    expect(isRuntimeRecoveryNotice("")).toBe(false);
    expect(isRuntimeRecoveryNotice(undefined)).toBe(false);
  });

  it("drops them for a customer, keeps them for an operator", () => {
    expect(shouldDropRuntimeNotice(cfg, CUSTOMER, TOMBSTONE)).toBe(true);
    expect(shouldDropRuntimeNotice(cfg, CUSTOMER, PENDING)).toBe(true);
    expect(shouldDropRuntimeNotice(cfg, OPERATOR, TOMBSTONE)).toBe(false);
    expect(shouldDropRuntimeNotice(cfg, "+972 50-721-6963", TOMBSTONE)).toBe(false);
    expect(shouldDropRuntimeNotice(cfg, CUSTOMER, "תודה, נחזור אליך")).toBe(false);
  });

  it("with no commands.allowFrom list everyone is an operator (as the runtime treats it)", () => {
    expect(shouldDropRuntimeNotice({}, CUSTOMER, TOMBSTONE)).toBe(false);
  });
});
