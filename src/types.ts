// ---------------------------------------------------------------------------
// WhatsApp Cloud API — Type Definitions
// ---------------------------------------------------------------------------

import type { HumanRhythmConfig } from "./human.js";
import type { FirstReplyConfig } from "./first-reply.js";
import type { HandbackConfig } from "./handback.js";

/** Plugin configuration (stored under channels.whatsapp-cloud in openclaw.json) */
/** A sendable WhatsApp Flow registered for this account (PinkLime fork). */
export interface FlowConfig {
  /** Meta Flow id (from WABA /flows) */
  flowId: string;
  /** CTA button label shown on the flow message */
  cta: string;
  /** Message body text above the CTA */
  bodyText?: string;
  /** First screen id (default: the Flow's own entry screen) */
  screen?: string;
}

export interface WhatsAppCloudConfig {
  enabled: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  webhookPort: number;
  webhookPath: string;
  apiVersion: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  sendReadReceipts: boolean;
  /** Named flows sendable via the "FLOW: <name>" reply directive (PinkLime fork). */
  flows: Record<string, FlowConfig>;
  /** Reply pacing so the bot answers with the rhythm of a person (PinkLime fork). */
  humanRhythm: HumanRhythmConfig;
  /** Canned, model-free answer to a known ad opener (PinkLime fork). */
  firstReply: FirstReplyConfig;
  /** Replay of a human takeover into the first message after the hand-back (PinkLime fork). */
  handback: HandbackConfig;
}

/** Defaults applied when config values are missing */
export const CONFIG_DEFAULTS: Partial<WhatsAppCloudConfig> = {
  enabled: true,
  verifyToken: "openclaw-wa-cloud-verify",
  webhookPort: 3100,
  webhookPath: "/webhook/whatsapp-cloud",
  apiVersion: "v21.0",
  dmPolicy: "open",
  allowFrom: [],
  sendReadReceipts: true,
};

// ---------------------------------------------------------------------------
// Meta Webhook Payload (inbound)
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  object: "whatsapp_business_account";
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  value: WebhookValue;
  field: string;
}

export interface WebhookValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WebhookContact[];
  messages?: IncomingMessage[];
  statuses?: MessageStatus[];
  errors?: WebhookError[];
}

export interface WebhookContact {
  profile: { name: string };
  wa_id: string;
}

export interface IncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: MessageType;
  text?: { body: string };
  image?: MediaObject;
  audio?: MediaObject;
  video?: MediaObject;
  document?: MediaObject & { filename?: string };
  sticker?: MediaObject;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string }; phones?: Array<{ phone: string }> }>;
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text: string; payload: string };
  context?: {
    from: string;
    id: string;
    referred_product?: { catalog_id: string; product_retailer_id: string };
  };
  /**
   * Click-to-WhatsApp ad attribution (PinkLime fork). Meta attaches it to the
   * FIRST message of a conversation started from an ad. It is recorded, never
   * acted on — nothing in the reply path branches on it.
   */
  referral?: MessageReferral;
}

/** Meta's click-to-WhatsApp referral block (all fields optional in practice). */
export interface MessageReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  ctwa_clid?: string;
}

export type MessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "order"
  | "unknown";

export interface MediaObject {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
}

export interface MessageStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: WebhookError[];
}

export interface WebhookError {
  code: number;
  title: string;
  message: string;
  error_data?: { details: string };
}

// ---------------------------------------------------------------------------
// Meta Cloud API — Outbound message types
// ---------------------------------------------------------------------------

export interface SendTextRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: { preview_url: boolean; body: string };
}

export interface SendTemplateRequest {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: TemplateComponent[];
  };
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  parameters: Array<{
    type: "text" | "currency" | "date_time" | "image" | "document" | "video";
    text?: string;
    image?: { link: string };
  }>;
}

export interface SendInteractiveRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: InteractiveMessage;
}

export interface InteractiveMessage {
  type: "button" | "list";
  header?: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  action: InteractiveAction;
}

export interface InteractiveAction {
  // Button type
  buttons?: Array<{
    type: "reply";
    reply: { id: string; title: string };
  }>;
  // List type
  button?: string;
  sections?: Array<{
    title: string;
    rows: Array<{
      id: string;
      title: string;
      description?: string;
    }>;
  }>;
}

export interface SendMediaRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "image" | "audio" | "video" | "document";
  image?: { link?: string; id?: string; caption?: string };
  audio?: { link?: string; id?: string };
  video?: { link?: string; id?: string; caption?: string };
  document?: { link?: string; id?: string; caption?: string; filename?: string };
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface SendMessageResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

export interface MediaUrlResponse {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
  messaging_product: "whatsapp";
}

export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

// ---------------------------------------------------------------------------
// Plugin internal types
// ---------------------------------------------------------------------------

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface UploadResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}
