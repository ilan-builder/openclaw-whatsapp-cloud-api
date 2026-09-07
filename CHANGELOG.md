# Changelog

This file records the **PinkLime fork** (`pinklime-main`) on top of
`mcostantino-dev/openclaw-whatsapp-cloud-api`. The LemonAid image pins the fork
by commit SHA, so an entry here is only live once that pin moves.

## Unreleased

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
