# Changelog

This file records the **PinkLime fork** (`pinklime-main`) on top of
`mcostantino-dev/openclaw-whatsapp-cloud-api`. The LemonAid image pins the fork
by commit SHA, so an entry here is only live once that pin moves.

## Unreleased

### Added — troll block: the agent decides, the platform enforces (2026-09-14)

Two real porcini conversations cost $0.33 and $0.37 to be insulted and then fed
fake event details, and both ended with a worthless lead handed to the team.
Nothing could stop them: every inbound message is a full cold prompt, and only
the model can tell a customer from a troll. New `src/block.ts`:

- **The marker.** A reply that carries `PINKLIME_BLOCK` anywhere in it (optional
  `:reason`, e.g. `PINKLIME_BLOCK:abusive`) sends the customer **nothing** — not
  the marker, not text around it, and no media in the same turn. The verdict is
  taken per dispatcher payload BEFORE `humanRhythm` splits it, and it holds for
  the rest of the turn, so a marked reply cannot leak one of its parts. Matching
  is "contains", the opposite of `first-reply.ts`, and for the opposite reason:
  the text is our own agent's, and a model that obeys almost — a stray full
  stop, one polite sentence in front — must still block.
- **The block.** `<openclaw home>/blocked/<peer>.json`, written atomically
  (tmp + rename): `{peer, reason, source:"bot"|"operator", blockedAt, blockedBy,
  triggerText, sessionKey}`. On the LemonAid platform the directory is a symlink
  to `<volume>/data/blocked` — **the container entrypoint must create it**,
  beside `first-reply/`, `referral/` and `takeover/`. The platform writes the
  same file for an operator's manual block.
- **Enforcement, as early as there is anything to enforce.** `webhook.ts` reads
  the block file before the read receipt and before the typing indicator, so a
  blocked number sees no sign that anyone is still there, and the message never
  reaches the runtime — zero tokens. The file is read fresh for EVERY message,
  never cached: an operator's unmute deletes it and the next message goes
  through.
- **A block is not a black hole.** Every dropped message is appended to
  `<peer>.jsonl` (capped at `logMax`, default 200) so the platform can merge it
  back into the transcript, flagged, and an operator can see the bot got it
  wrong. An unmute keeps the log.
- **Lifting your own block.** `/new` and `/reset` are the one message the gate
  lets through. Authorization is decided against `commands.allowFrom` on the
  full runtime config, which only the channel handler holds, so the command
  passes the gate carrying the block and `index.ts` makes the call: authorized
  clears the block and falls through (the reset also happens), unauthorized
  stops there. Neither reaches the model.
- `enabled` defaults to **true**, like `handback` and unlike `firstReply`: a bot
  whose prompt never emits the marker never blocks anybody, but the platform's
  manual Block button must work for every client.

32 tests in `src/__tests__/block.test.ts`, including the multi-part leak, the
read-receipt silence and the unmute.

### Added — click-to-WhatsApp referral reaches the model (2026-09-07)

Meta's `referral` object was parsed and logged, and kept on the first-reply entry
when the canned reply fired. It never reached the agent, so a customer who tapped
an ad had to say which product they meant. New `src/referral.ts`:

- **Persist.** Any inbound message carrying a `referral` writes
  `<openclaw home>/referral/<peer>.json` atomically (tmp + rename), the same way
  first-reply writes its state: `{peer, ts, waMessageId, referral, product?,
  deliveredAt}`. A newer click overwrites an older undelivered one. On the
  LemonAid platform the directory is a symlink to `<volume>/data/referral` —
  **the container entrypoint must create it**, beside `first-reply/` and
  `takeover/`.
- **Match (optional).** `channels."whatsapp-cloud".referralProducts` maps an ad
  to a catalogue product by `sourceId` (exact) or by a case-insensitive regex
  over `headline` / `body`. First rule whose every given matcher matches wins; a
  rule with no recognised matcher is dropped rather than treated as a catch-all.
- **Deliver, exactly once.** A `[PINKLIME_REFERRAL]` block is prepended to
  `BodyForAgent` on the first turn that reaches the model after the click — the
  customer's second message when the canned first reply answered the first one,
  the same message otherwise. The claim is an atomic rename, as in
  `handback.ts`; the claimed copy stays as `<peer>.delivered.json` with
  `deliveredAt` stamped. A slash command and a Flow completion never spend it.
  The block goes in front of `[PINKLIME_HISTORY]` and `[PINKLIME_TAKEOVER]`,
  because the click happened before both.
- **Product-aware canned opener.** `firstReply.referralText` /
  `referralTextNoName` (placeholders `{name}`, `{name_comma}`, `{product}`) are
  used instead of `text` / `textNoName` when the opener arrived from a matched
  ad. Absent = today's behaviour; an empty render is still never sent.
- **New knobs** under `channels."whatsapp-cloud".referral`: `enabled` (default
  true), `stateDir`, `preamble`, `bodyMaxChars` (300).
- **Logs**: `[referral] <masked peer> ad=… src=… product=…` on the click,
  `[referral] delivered to agent for <masked peer>` on the delivery, plus one
  startup line when product rules are configured.
- 46 new tests (`src/__tests__/referral.test.ts`); the suite is 169 tests.

Nothing is delivered for a peer who arrived from no ad, and a client that
configures nothing keeps every previous behaviour.

## Earlier fork work (no entries were kept at the time)

- `963046c` log successful outbound text sends
- `eb4e3b0` `/new` makes the peer a new visitor again
- `1b4266a` the hand-back replay (`[PINKLIME_TAKEOVER]`)
- `26c5581` "enabled with no text" is inactive, never an empty message
- `f9a78a3` replay the history on `BodyForAgent`
- earlier: canned first reply, `humanRhythm`, WhatsApp Flows, inbound media
  download, per-number event filtering, resident `startAccount`
