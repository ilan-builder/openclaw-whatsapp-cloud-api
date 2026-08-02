import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Flow tokens (PinkLime fork)
//
// A flow_token is minted when a Flow message is sent and echoed back inside the
// completion's response_json. HMAC-signing it with the app secret lets the
// inbound handler trust that a completion belongs to a Flow WE sent to THIS
// peer — without any server-side state.
// ---------------------------------------------------------------------------

export interface FlowTokenPayload {
  /** flow name from the config registry */
  f: string;
  /** peer (wa_id) the flow was sent to */
  p: string;
  /** mint timestamp (ms) */
  t: number;
}

export function mintFlowToken(payload: FlowTokenPayload, appSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", appSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyFlowToken(token: string, appSecret: string): FlowTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", appSecret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!timingSafeEqual(a, b)) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString()) as FlowTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Verify the X-Hub-Signature-256 header from Meta webhook requests.
 *
 * Meta signs every webhook payload with HMAC-SHA256 using your App Secret.
 * Always validate this in production to prevent forged webhook calls.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const expectedSignature =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    const sigBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) return false;

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
