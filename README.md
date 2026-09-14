# OpenClaw WhatsApp Cloud API Channel

WhatsApp channel for [OpenClaw](https://github.com/openclaw/openclaw) using Meta's **official Cloud API** — production-safe, no Baileys, no ban risk.

## Why this plugin?

OpenClaw's built-in WhatsApp channel uses [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered WhatsApp Web protocol. It works great for personal use, but Meta can ban accounts at any time — making it unsuitable for business bots.

This plugin uses the **official WhatsApp Cloud API** (`graph.facebook.com`) instead:

| | Built-in (Baileys) | This plugin (Cloud API) |
|---|---|---|
| Auth | QR code scan | OAuth access token |
| Ban risk | High (unofficial) | None (official) |
| 24-hour window | No restriction | Required (templates after 24h) |
| Cost | Free | Pay-per-conversation |
| Sending first | Anytime | Templates only |
| Best for | Personal assistant | Customer-facing bots |

## Prerequisites

- **OpenClaw** >= 2026.2.x installed and configured (`openclaw configure`)
- **Node.js** >= 22
- A **Meta Business App** with WhatsApp product enabled
- A domain with **HTTPS** for the webhook (ngrok for dev, reverse proxy for prod)

## Quick start (development)

### 1. Install the plugin

```bash
git clone https://github.com/baiadigitale/openclaw-channel-whatsapp-cloud.git
cd openclaw-channel-whatsapp-cloud
npm install && npm run build
openclaw plugins install -l .
```

> **Note:** Due to a known OpenClaw bug with symlinks, if the plugin isn't discovered after `install -l .`, add this to `~/.openclaw/openclaw.json`:
> ```json
> {
>   "plugins": {
>     "load": {
>       "paths": ["/absolute/path/to/openclaw-channel-whatsapp-cloud"]
>     }
>   }
> }
> ```

### 2. Get Meta credentials

1. Go to [developers.facebook.com](https://developers.facebook.com/) and create an app (type: **Business**)
2. Add the **WhatsApp** product
3. In **WhatsApp > API Setup**, note your **Phone Number ID**
4. Create a permanent access token:
   - **Business Settings > System Users** > create one with **Admin** role
   - Generate a token with permissions: `whatsapp_business_messaging`, `whatsapp_business_management`
5. Note your **App Secret** from **App Settings > Basic** (for webhook signature verification)

### 3. Run the setup wizard

```bash
openclaw whatsapp-cloud setup
```

This will prompt for all credentials and save them to `~/.openclaw/openclaw.json`.

Alternatively, set them manually:

```bash
openclaw config set channels.whatsapp-cloud.phoneNumberId "YOUR_PHONE_NUMBER_ID"
openclaw config set channels.whatsapp-cloud.accessToken "YOUR_ACCESS_TOKEN"
openclaw config set channels.whatsapp-cloud.appSecret "YOUR_APP_SECRET"
openclaw config set channels.whatsapp-cloud.verifyToken "a-random-string-you-choose"
```

### 4. Expose the webhook (dev)

```bash
ngrok http 3100
```

Copy the `https://xxxx.ngrok-free.app` URL.

### 5. Register the webhook on Meta

1. Go to **WhatsApp > Configuration** in your Meta app
2. Click **Edit** on the Webhook section
3. **Callback URL**: `https://your-ngrok-url/webhook/whatsapp-cloud`
4. **Verify Token**: the string you chose in step 3
5. Click **Verify and Save**
6. Subscribe to the **messages** webhook field

### 6. Start the gateway

```bash
openclaw gateway restart
```

Send a WhatsApp message to your business number — the bot will respond.

---

## Production deployment

### Architecture

```
User on WhatsApp
      |
      v
Meta Cloud API (graph.facebook.com)
      |
      v  HTTPS POST
+--------------------------------------------------+
|  Your server (VPS / Docker / Cloud)              |
|                                                  |
|  nginx/Caddy (TLS termination, port 443)         |
|      |                                           |
|      v  proxy_pass :3100                         |
|  OpenClaw Gateway (systemd service)              |
|    +-- whatsapp-cloud plugin                     |
|    |     webhook.ts  -> receives messages         |
|    |     crypto.ts   -> verifies HMAC signature   |
|    |     index.ts    -> dispatches to agent        |
|    |     api.ts      -> sends replies              |
|    +-- agent (Claude / GPT / ...)                |
+--------------------------------------------------+
```

### Recommended repo structure

Create a **deployment repository** separate from this plugin:

```
my-openclaw-bot/
  openclaw.json          # OpenClaw config (env var refs for secrets)
  .env.example           # Documents all required env vars
  .env                   # Actual secrets (NEVER commit this)
  .gitignore
  workspace/
    AGENTS.md            # Agent instructions, persona, behavior rules
    SOUL.md              # Personality, tone, boundaries
    IDENTITY.md          # Agent name, emoji
    USER.md              # Info about the user/company
    TOOLS.md             # Tool-specific notes
  scripts/
    deploy.sh            # Deployment automation
    backup.sh            # State backup
  docker-compose.yml     # Optional: containerized deployment
  Caddyfile              # Or nginx.conf — reverse proxy config
```

**`.gitignore`:**
```
.env
*.bak
sessions/
credentials/
```

**`openclaw.json`** (with env var references):
```json5
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  },

  // LLM provider
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "./workspace",
      "models": {
        "anthropic/claude-sonnet-4-5": {}
      }
    }
  },

  // WhatsApp Cloud channel
  "channels": {
    "whatsapp-cloud": {
      "phoneNumberId": "${WHATSAPP_PHONE_NUMBER_ID}",
      "accessToken": "${WHATSAPP_ACCESS_TOKEN}",
      "appSecret": "${WHATSAPP_APP_SECRET}",
      "verifyToken": "${WHATSAPP_VERIFY_TOKEN}",
      "webhookPort": 3100,
      "dmPolicy": "open",
      "sendReadReceipts": true
    }
  },

  // Plugin
  "plugins": {
    "entries": {
      "whatsapp-cloud": { "enabled": true }
    }
  }
}
```

**`.env.example`:**
```bash
# Anthropic API key (get from https://console.anthropic.com/settings/keys)
ANTHROPIC_API_KEY=sk-ant-...

# OpenClaw gateway auth token (generate: openssl rand -hex 24)
OPENCLAW_GATEWAY_TOKEN=

# WhatsApp Cloud API (from https://developers.facebook.com/)
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
```

### Install on a production server

```bash
# 1. Install OpenClaw
npm install -g openclaw

# 2. Clone the plugin (private repo — no npm publish needed)
git clone git@github.com:baiadigitale/openclaw-channel-whatsapp-cloud.git ~/extensions/whatsapp-cloud
cd ~/extensions/whatsapp-cloud && npm install && npm run build

# 3. Clone your deployment repo
git clone https://github.com/yourorg/my-openclaw-bot.git ~/openclaw-bot
cd ~/openclaw-bot

# 4. Copy env file and fill in secrets
cp .env.example .env
nano .env

# 5. Point OpenClaw to your config
export OPENCLAW_CONFIG_PATH=~/openclaw-bot/openclaw.json
export OPENCLAW_STATE_DIR=~/openclaw-bot/.state

# 6. Install and start the gateway
openclaw gateway install
systemctl --user start openclaw-gateway.service
systemctl --user enable openclaw-gateway.service
```

Make sure your `openclaw.json` loads the plugin from the cloned path:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/extensions/whatsapp-cloud"]
    },
    "entries": {
      "whatsapp-cloud": { "enabled": true }
    }
  }
}
```

### Update the plugin

After pushing changes to the repo, run this on the server:

```bash
cd ~/extensions/whatsapp-cloud && git pull && npm install && npm run build && systemctl --user restart openclaw-gateway.service
```

### Reverse proxy (Caddy)

**`Caddyfile`:**
```
yourdomain.com {
    reverse_proxy /webhook/whatsapp-cloud localhost:3100
}
```

```bash
sudo caddy start --config Caddyfile
```

Caddy handles TLS automatically via Let's Encrypt.

**nginx alternative:**
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location /webhook/whatsapp-cloud {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Docker deployment (optional)

**`docker-compose.yml`:**
```yaml
services:
  openclaw:
    image: node:22-slim
    working_dir: /app
    command: ["npx", "openclaw", "gateway", "--bind", "lan", "--port", "3100"]
    env_file: .env
    environment:
      OPENCLAW_CONFIG_PATH: /app/openclaw.json
      OPENCLAW_STATE_DIR: /data
      NODE_ENV: production
    volumes:
      - ./openclaw.json:/app/openclaw.json:ro
      - ./workspace:/app/workspace:ro
      - openclaw-data:/data
    ports:
      - "3100:3100"
    restart: unless-stopped

volumes:
  openclaw-data:
```

### Monitoring

```bash
# Live logs
journalctl --user -u openclaw-gateway.service -f

# Channel status
openclaw whatsapp-cloud status

# Gateway health
openclaw gateway status

# Send a test message
openclaw whatsapp-cloud test +39XXXXXXXXXX
```

### Security checklist

- [ ] `appSecret` is set (enables webhook HMAC signature verification)
- [ ] Access token is a **System User token** (permanent, not a temporary test token)
- [ ] `dmPolicy` is set to `"allowlist"` if the bot should only serve specific numbers
- [ ] Webhook endpoint is HTTPS-only
- [ ] `.env` file has `chmod 600` and is not committed to git
- [ ] Gateway auth token is set (`gateway.auth.mode: "token"`)
- [ ] Gateway binds to loopback only (reverse proxy handles external traffic)

---

## Configuration reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `phoneNumberId` | string | *required* | WhatsApp Phone Number ID |
| `businessAccountId` | string | — | WhatsApp Business Account ID |
| `accessToken` | string | *required* | Meta API access token (system user token) |
| `appSecret` | string | — | Meta App Secret for webhook signature verification |
| `verifyToken` | string | `"openclaw-wa-cloud-verify"` | Custom token for webhook endpoint verification |
| `webhookPort` | number | `3100` | HTTP server port for webhooks |
| `webhookPath` | string | `"/webhook/whatsapp-cloud"` | URL path for the webhook endpoint |
| `apiVersion` | string | `"v21.0"` | Meta Graph API version |
| `dmPolicy` | string | `"open"` | `"open"` (anyone) or `"allowlist"` (restricted) |
| `allowFrom` | string[] | `[]` | E.164 numbers allowed when dmPolicy=allowlist |
| `sendReadReceipts` | boolean | `true` | Auto-mark incoming messages as read |
| `humanRhythm` | object | *off* | Reply pacing, see below (PinkLime fork) |
| `firstReply` | object | *off* | Canned, model-free answer to a known ad opener (PinkLime fork) |
| `handback` | object | *on* | Replay of a human takeover into the next message (PinkLime fork) |
| `referral` | object | *on* | Click-to-WhatsApp ad delivered to the model once, see below (PinkLime fork) |
| `referralProducts` | array | `[]` | Ad → product rules, see below (PinkLime fork) |

### `humanRhythm` — reply like a person, not a bot

A reply that lands three seconds after the customer's message reads as automated
whatever it says. `humanRhythm` paces the outbound side:

```
read receipt (immediate)  ->  typing after a pause  ->  reply after minMs..maxMs
```

The wait is a **target total**, not an added delay: the model generates while the
timer runs, so a reply that took 4s to write waits the remaining time only, and a
reply that took 20s is sent the moment it is ready. A fresh random value is drawn
per message, so no two waits look alike.

It also turns a reply written as **two paragraphs** into two WhatsApp messages
with a short gap, which is how a person texts. Single newlines are untouched, so
a three-line reply stays one message.

```json5
{
  channels: {
    "whatsapp-cloud": {
      humanRhythm: {
        enabled: true,
        minMs: 8000,
        maxMs: 15000,
      },
    },
  },
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch. Off = the plugin behaves exactly as before |
| `minMs` | number | `8000` | Lower bound of the target time from inbound message to first reply |
| `maxMs` | number | `15000` | Upper bound of that target. Clamped up to `minMs` |
| `typingAfterMs` | number | `2500` | Pause before the typing indicator appears (a person reads first) |
| `splitParagraphs` | boolean | `true` | Send a blank-line-separated reply as separate messages |
| `maxParts` | number | `3` | Hard cap on messages per reply; the tail is merged |
| `partGapMinMs` | number | `2500` | Gap between those messages, lower bound |
| `partGapMaxMs` | number | `5000` | Gap between those messages, upper bound |
| `maxPartChars` | number | `400` | A paragraph longer than this is a long answer: never split |

The typing indicator is refreshed every 20s while the pacer waits, because Meta
drops it after 25s.

### `block` — the agent blocks a troll, the platform enforces it

Every inbound WhatsApp message is a full cold prompt. A troll who keeps writing
therefore keeps spending, and the only thing that can tell a troll from a
customer is the model itself. So the **bot decides** and the **channel
enforces**.

Tell the agent, in its own prompt, to answer a troll with one marker and nothing
else. When a reply carries `PINKLIME_BLOCK` anywhere in it, the channel:

1. sends the customer **nothing** — not the marker, not any text around it, and
   no media from the same turn,
2. writes `<openclaw home>/blocked/<peer>.json`,
3. and from the next message on, drops that number **before the read receipt and
   before the typing indicator**, so it never reaches the runtime at all.

```json
{
  "channels": {
    "whatsapp-cloud": {
      "block": {
        "enabled": true,
        "marker": "PINKLIME_BLOCK",
        "logMax": 200
      }
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | A bot whose prompt never emits the marker never blocks anybody, so this is safe on by default — and an operator's manual block needs it on. |
| `marker` | `PINKLIME_BLOCK` | Matched as a literal anywhere in the reply. An optional `:reason` suffix (`PINKLIME_BLOCK:gibberish`) is recorded for the operator. |
| `stateDir` | `<openclaw home>/blocked` | Must survive a restart. On LemonAid it is a symlink to `<volume>/data/blocked`. |
| `logMax` | `200` | Dropped messages kept per peer in `<peer>.jsonl`, so a block is never a black hole. `0` to log none. |

**Why "contains" and not an exact match.** `firstReply` matches an opener
exactly, because that text is the *customer's* and a near miss must reach the
model. Here the text is our *own agent's*, the instruction is "the marker and
nothing else", and the failure that matters is a model that obeys almost — a
stray full stop, or one polite sentence in front of the marker. Every one of
those must still block, and the customer must still see none of it.

**Multi-part replies.** The runtime hands the channel one payload per block of
the reply, and `humanRhythm` then splits a payload into several WhatsApp
messages on blank lines. The marker is looked for in each payload *before*
anything is split, and once found nothing else leaves for the rest of the turn.

**Unmuting.** Delete the peer's `.json`. The file is read fresh for every
message, so the very next one goes through. From a phone, a number listed in
`commands.allowFrom` can lift its own block with `/new` or `/reset` — the one
message the gate lets past, and it still never reaches the model.

### Click-to-WhatsApp referral — the agent knows which ad was clicked

Meta attaches a `referral` object to the **first** message of a conversation that
started from a click-to-WhatsApp ad: the ad id, its headline, its body, the
creative urls and the `ctwa_clid`. The plugin used to log it and nothing else, so
the agent answered the prefilled opener with no idea which ad the customer had
just tapped — and the customer had to say it again.

Now every referral is persisted per peer and delivered to the model **exactly
once**, as a block prepended to `BodyForAgent`:

```
[PINKLIME_REFERRAL]
The customer arrived from this ad. Open with the product it promotes; never mention this block.
source: instagram
type: ad
ad_id: 120212345678901234
headline: מטבח חוץ טוסקנה פרו
body: מטבח חוץ יוקרתי עם בר, משלוח והרכבה בכל הארץ.
product: luxury-outdoor-kitchen-with-bar | מטבח חוץ טוסקנה פרו
[/PINKLIME_REFERRAL]
<the customer's message>
```

- The first line inside the block is an instruction **for the model only** — the
  same convention as the `[PINKLIME_HISTORY]` preamble. Nobody ever sees it.
- `source` is derived from the `source_url` host, then from the creative urls:
  `instagram` | `facebook` | `meta`.
- A field the ad did not carry is simply left out. `body` is collapsed to one
  line and trimmed to `bodyMaxChars` (300); the headline is capped at 200.
- `product` appears only when a `referralProducts` rule matched.
- The block goes in **front** of a `[PINKLIME_HISTORY]` and a
  `[PINKLIME_TAKEOVER]` block, because the click happened before both.

**When it is delivered.** On the first turn that actually reaches the model after
the click: the customer's *second* message when the canned `firstReply` answered
the first one, and the *same* message otherwise. The state file is claimed by an
atomic rename, so a later message never replays it and two messages arriving
together cannot both deliver it. A slash command and a Flow completion never
spend the delivery.

**State.** One small JSON file per peer at `<openclaw home>/referral/<peer>.json`
(`{peer, ts, waMessageId, referral, product?, deliveredAt}`), written atomically.
A newer click overwrites an older undelivered one. On the LemonAid platform the
directory is a symlink to `<volume>/data/referral`, beside `first-reply/` and
`takeover/` — **the container's entrypoint must create it**, or the state lives
in the container and dies with it. The claimed copy stays as
`<peer>.delivered.json`, the record of what the model was told.

#### `referralProducts` — map an ad to a product

Optional. Without it the block still names the ad; with it, the agent is told
which catalogue item the ad promotes.

```json5
{
  channels: {
    "whatsapp-cloud": {
      referralProducts: [
        {
          match: { headline: "טוסקנה" },
          slug: "luxury-outdoor-kitchen-with-bar",
          name: "מטבח חוץ טוסקנה פרו",
        },
      ],
    },
  },
}
```

| Key | Type | Description |
|-----|------|-------------|
| `match.sourceId` | string | Meta's `source_id` (the ad id). Compared **exactly** |
| `match.headline` | string | Regex over the ad headline, case-insensitive |
| `match.body` | string | Regex over the ad body, case-insensitive |
| `slug` | string | The product slug handed to the agent |
| `name` | string | The product name, also used by `firstReply.referralText` |

The **first** rule whose **every given** matcher matches wins; several matchers
in one rule are ANDed. A rule with no recognised matcher is **dropped, never
treated as a catch-all** — a typo (`sourceID`) would otherwise attach one product
to every ad the client runs, silently. A broken regex matches nothing.

#### `firstReply.referralText` — a product-aware canned opener

When the opener arrived from an ad that matched a rule, the canned first reply
uses `referralText` / `referralTextNoName` instead of `text` / `textNoName`.
Placeholders: `{name}`, `{name_comma}` and `{product}` (the rule's `name`).
Empty or absent = the normal texts answer, exactly as before; an empty render is
never sent.

#### `referral` — the behaviour knobs

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Off = nothing is persisted and nothing is delivered |
| `stateDir` | string | `<openclaw home>/referral` | Where the per-peer files live |
| `preamble` | string | *see above* | The model-only instruction line inside the block |
| `bodyMaxChars` | number | `300` | The ad body is trimmed to this before it reaches the prompt |

**Logs**: `[referral] 9725******52 ad=1202… src=instagram product=luxury-…` on
the click, `[referral] delivered to agent for 9725******52` on the delivery, and
one startup line naming how many product rules are configured.

## Features

### Inbound message types

- Text messages
- Images (with/without captions)
- Audio, video, documents, stickers
- Location sharing
- Contact cards
- Interactive replies (button and list selections)
- Quoted messages (reply context)

### Outbound capabilities

- Text messages (auto-split at 4096 chars)
- Interactive buttons (up to 3 quick reply buttons)
- Interactive lists (section-based menus)
- Media messages (image, audio, video, document)
- Template messages (for messages outside the 24h window)
- Read receipts

### Security

- HMAC-SHA256 webhook signature verification (via App Secret)
- Timing-safe comparison to prevent timing attacks
- DM policy (open / allowlist)
- Phone number normalization for allowlist matching

## The 24-hour messaging window

WhatsApp Cloud API enforces a **24-hour customer service window**:

- When a customer messages you, you have **24 hours** to respond with free-form text
- After the window closes, you can only send **pre-approved template messages**
- Each template must be submitted to Meta for review

This plugin handles free-form responses automatically. For proactive notifications, use the `sendTemplate` API:

```typescript
import { sendTemplate } from "@baia-digitale/whatsapp-cloud";
```

## Development

```bash
git clone https://github.com/baiadigitale/openclaw-channel-whatsapp-cloud.git
cd openclaw-channel-whatsapp-cloud
npm install

npm run type-check    # TypeScript strict mode
npm test              # 32 tests
npm run dev           # Watch mode (auto-rebuild)

# Link to OpenClaw for development
openclaw plugins install -l .
```

### Project structure

```
src/
  index.ts        — Plugin entry point + channel definition
  types.ts        — TypeScript interfaces
  api.ts          — Meta Cloud API client (outbound)
  webhook.ts      — HTTP server (inbound webhooks)
  crypto.ts       — HMAC-SHA256 signature verification
  block.ts        — Troll block: the agent's marker, per-peer block files
  setup.ts        — Interactive setup wizard
  runtime.ts      — OpenClaw runtime accessor
  __tests__/      — Vitest test suites
```

## Rate limits

New WhatsApp Business accounts start at **250 unique recipients per 24 hours**. As quality improves:

250 > 1,000 > 10,000 > 100,000 > unlimited

## Troubleshooting

**Webhook verification fails:**
- Ensure `verifyToken` in OpenClaw config matches what you entered in Meta dashboard
- The webhook URL must be reachable over HTTPS

**Messages not arriving:**
- Check that you subscribed to the `messages` webhook field in Meta dashboard
- Check logs: `journalctl --user -u openclaw-gateway.service -f`
- Verify `appSecret` is correct (wrong secret = messages silently dropped)

**"phoneNumberId?.trim is not a function":**
- The `phoneNumberId` was saved as a number instead of a string. Fix it in `~/.openclaw/openclaw.json` by wrapping the value in quotes: `"phoneNumberId": "878388375365101"`

**Plugin not found after `install -l .`:**
- OpenClaw has a symlink discovery bug. Add `plugins.load.paths` to your config pointing to the plugin directory (see install instructions above)

**Gateway won't start:**
- Set `gateway.mode`: `openclaw config set gateway.mode local`
- Check logs: `journalctl --user -u openclaw-gateway.service -n 50`

## License

MIT — [Baia Digitale SRL](https://baiadigitale.com)
