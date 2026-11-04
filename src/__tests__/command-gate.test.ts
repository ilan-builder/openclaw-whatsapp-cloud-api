import { describe, expect, it, vi } from "vitest";
import { isSlashCommand, shouldDropUnauthorizedCommand } from "../command-gate.js";

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
