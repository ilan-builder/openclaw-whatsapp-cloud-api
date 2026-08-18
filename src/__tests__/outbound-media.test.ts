import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { WhatsAppCloudConfig } from "../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  isRemoteMediaUrl,
  mediaTypeForMime,
  mediaUrlsFromPayload,
  mimeForFileName,
  resolveLocalMediaPath,
  sendOutboundMedia,
} from "../media.js";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeConfig(): WhatsAppCloudConfig {
  return {
    enabled: true,
    phoneNumberId: "111222333",
    businessAccountId: "444555666",
    accessToken: "test_token",
    appSecret: "test_secret",
    verifyToken: "test-verify",
    webhookPort: 3100,
    webhookPath: "/webhook/whatsapp-cloud",
    apiVersion: "v21.0",
    dmPolicy: "open",
    allowFrom: [],
    sendReadReceipts: true,
  };
}

function mockSendSuccess(messageId = "wamid.sent123") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      messaging_product: "whatsapp",
      contacts: [{ input: "+972543343052", wa_id: "972543343052" }],
      messages: [{ id: messageId }],
    }),
  });
}

function mockUploadSuccess(mediaId = "media-abc-123") {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: mediaId }) });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "wa-cloud-outbound-"));
const imagePath = join(tmpRoot, "wedding-starters-evening-event.jpg");
writeFileSync(imagePath, Buffer.from("fake-jpeg-bytes"));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.error.mockReset();
});

describe("media source classification", () => {
  it("treats http and https as remote", () => {
    expect(isRemoteMediaUrl("https://example.com/a.jpg")).toBe(true);
    expect(isRemoteMediaUrl("http://example.com/a.jpg")).toBe(true);
  });

  it("treats local paths as not remote", () => {
    expect(isRemoteMediaUrl("/home/node/.openclaw/workspace/a.jpg")).toBe(false);
    expect(isRemoteMediaUrl("~/.openclaw/workspace/a.jpg")).toBe(false);
    expect(isRemoteMediaUrl("file:///tmp/a.jpg")).toBe(false);
  });

  it("maps extensions to mime types and media types", () => {
    expect(mimeForFileName("dish.jpg")).toBe("image/jpeg");
    expect(mimeForFileName("clip.mp4")).toBe("video/mp4");
    expect(mimeForFileName("menu.pdf")).toBe("application/pdf");
    expect(mediaTypeForMime("image/jpeg")).toBe("image");
    expect(mediaTypeForMime("video/mp4")).toBe("video");
    expect(mediaTypeForMime("audio/ogg")).toBe("audio");
    expect(mediaTypeForMime("application/pdf")).toBe("document");
  });

  it("expands ~ and file:// into real paths", () => {
    expect(resolveLocalMediaPath("~/pics/a.jpg")).toBe(join(homedir(), "pics/a.jpg"));
    expect(resolveLocalMediaPath("file:///tmp/a.jpg")).toBe("/tmp/a.jpg");
    expect(resolveLocalMediaPath("/abs/a.jpg")).toBe("/abs/a.jpg");
  });
});

describe("sendOutboundMedia", () => {
  it("sends a remote URL by link without uploading", async () => {
    mockSendSuccess();

    const result = await sendOutboundMedia(
      makeConfig(),
      "972543343052",
      "https://example.com/dish.jpg",
      "caption here",
      mockLog
    );

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/111222333/messages");
    const body = JSON.parse(init.body);
    expect(body.type).toBe("image");
    expect(body.image).toEqual({ link: "https://example.com/dish.jpg", caption: "caption here" });
  });

  it("uploads a local file and sends it by media id", async () => {
    mockUploadSuccess("media-abc-123");
    mockSendSuccess("wamid.local1");

    const result = await sendOutboundMedia(
      makeConfig(),
      "972543343052",
      imagePath,
      "מנות פתיחה",
      mockLog
    );

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.local1");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadInit] = mockFetch.mock.calls[0];
    expect(uploadUrl).toContain("/111222333/media");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(uploadInit.body.get("messaging_product")).toBe("whatsapp");
    expect(uploadInit.body.get("type")).toBe("image/jpeg");
    // multipart boundary must be left to fetch
    expect(uploadInit.headers["Content-Type"]).toBeUndefined();

    const [sendUrl, sendInit] = mockFetch.mock.calls[1];
    expect(sendUrl).toContain("/111222333/messages");
    const body = JSON.parse(sendInit.body);
    expect(body.type).toBe("image");
    expect(body.image).toEqual({ id: "media-abc-123", caption: "מנות פתיחה" });
    expect(body.image.link).toBeUndefined();
  });

  it("expands a ~ path before reading the file", async () => {
    const result = await sendOutboundMedia(
      makeConfig(),
      "972543343052",
      "~/definitely-missing-file.jpg",
      undefined,
      mockLog
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain(join(homedir(), "definitely-missing-file.jpg"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails cleanly when the local file is missing", async () => {
    const result = await sendOutboundMedia(
      makeConfig(),
      "972543343052",
      join(tmpRoot, "no-such-image.jpg"),
      undefined,
      mockLog
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("local media file unreadable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send when the upload is rejected", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: { message: "(#100) Invalid media" } }),
    });

    const result = await sendOutboundMedia(
      makeConfig(),
      "972543343052",
      imagePath,
      undefined,
      mockLog
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("(#100) Invalid media");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("attaches a filename and no caption for documents and audio", async () => {
    const pdfPath = join(tmpRoot, "menu.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    mockUploadSuccess("media-pdf-1");
    mockSendSuccess();

    await sendOutboundMedia(makeConfig(), "972543343052", pdfPath, "the menu", mockLog);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.type).toBe("document");
    expect(body.document).toEqual({
      id: "media-pdf-1",
      caption: "the menu",
      filename: "menu.pdf",
    });
  });
});

describe("mediaUrlsFromPayload", () => {
  const PHOTO = "/home/node/.openclaw/workspace/product-images/porcini-image-01.jpg";

  // The regression this guards: a single MEDIA: line produces a payload with the
  // SAME file in both fields, and sending each field in turn delivered the photo
  // twice to the customer.
  it("sends one photo once when both fields carry it", () => {
    expect(mediaUrlsFromPayload({ mediaUrl: PHOTO, mediaUrls: [PHOTO] })).toEqual([PHOTO]);
  });

  it("keeps every distinct file when several are attached", () => {
    const b = "/tmp/second.jpg";
    expect(mediaUrlsFromPayload({ mediaUrl: PHOTO, mediaUrls: [PHOTO, b] })).toEqual([PHOTO, b]);
  });

  it("de-duplicates repeats inside the list", () => {
    expect(mediaUrlsFromPayload({ mediaUrls: [PHOTO, PHOTO] })).toEqual([PHOTO]);
  });

  it("falls back to the single field when the list is absent or empty", () => {
    expect(mediaUrlsFromPayload({ mediaUrl: PHOTO })).toEqual([PHOTO]);
    expect(mediaUrlsFromPayload({ mediaUrl: PHOTO, mediaUrls: [] })).toEqual([PHOTO]);
  });

  it("returns nothing for a text-only payload", () => {
    expect(mediaUrlsFromPayload({})).toEqual([]);
    expect(mediaUrlsFromPayload({ mediaUrl: null, mediaUrls: null })).toEqual([]);
    expect(mediaUrlsFromPayload({ mediaUrl: "   " })).toEqual([]);
  });
});
