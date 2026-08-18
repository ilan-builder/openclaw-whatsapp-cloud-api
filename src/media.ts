// ---------------------------------------------------------------------------
// Inbound media persistence — download WhatsApp media to a local temp file so
// the agent runtime can process it (audio transcription via {{MediaPath}},
// image understanding, documents).
//
// PinkLime fork addition: upstream parses media metadata but never downloads
// the binary, which leaves voice notes as "[🎵 Audio message]" placeholders.
// ---------------------------------------------------------------------------

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMediaUrl, downloadMedia, sendMedia, uploadMedia } from "./api.js";
import type { WhatsAppCloudConfig, SendResult, Logger } from "./types.js";
import type { ParsedInboundMessage } from "./webhook.js";

const MEDIA_DIR = join(tmpdir(), "openclaw-wa-cloud-media");
const MAX_AGE_MS = 60 * 60 * 1000; // best-effort cleanup of files older than 1h

const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "audio/aac": "aac",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

function extensionFor(mimeType: string, filename?: string): string {
  const fromName = filename?.split(".").pop();
  if (fromName && fromName.length <= 5) return fromName;
  const base = mimeType.split(";")[0].trim();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
  const subtype = base.split("/")[1];
  return subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : "bin";
}

async function cleanupOldFiles(log: Logger): Promise<void> {
  try {
    const files = await readdir(MEDIA_DIR);
    const now = Date.now();
    for (const file of files) {
      const path = join(MEDIA_DIR, file);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > MAX_AGE_MS) await unlink(path);
      } catch {
        // file vanished between readdir and stat — fine
      }
    }
  } catch (err) {
    log.debug?.(`[whatsapp-cloud] Media cleanup skipped: ${err}`);
  }
}

/**
 * Download an inbound message's media object to a local temp file.
 * Returns the absolute file path and content type, or null on failure
 * (the message still dispatches with its text placeholder).
 */
export async function saveInboundMedia(
  config: WhatsAppCloudConfig,
  media: NonNullable<ParsedInboundMessage["media"]>,
  messageId: string,
  log: Logger
): Promise<{ path: string; mimeType: string } | null> {
  const url = await getMediaUrl(config, media.id, log);
  if (!url) return null;

  const downloaded = await downloadMedia(config, url, log);
  if (!downloaded) return null;

  const mimeType = media.mimeType || downloaded.mimeType;
  // messageId is Meta's wamid (base64-ish) — sanitize for the filesystem
  const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(-48);
  const fileName = `${Date.now()}-${safeId}.${extensionFor(mimeType, media.filename)}`;
  const path = join(MEDIA_DIR, fileName);

  try {
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(path, downloaded.buffer);
  } catch (err) {
    log.error(`[whatsapp-cloud] Failed to persist media: ${err}`);
    return null;
  }

  cleanupOldFiles(log).catch(() => {});
  log.info?.(
    `[whatsapp-cloud] Media saved: ${path} (${mimeType}, ${downloaded.buffer.length} bytes)`
  );
  return { path, mimeType };
}

// ---------------------------------------------------------------------------
// Outbound media — local files must be uploaded before they can be sent.
//
// PinkLime fork addition: the outbound adapter used to pass whatever string it
// received straight into `image.link`. A local path such as
// /home/node/.openclaw/workspace/product-images/dish.jpg made Meta answer
// "(#100) Param image.link is not a valid URI" and the send failed. Local files
// now go to the /{phone-number-id}/media endpoint and are sent by media id.
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  pdf: "application/pdf",
};

export type OutboundMediaType = "image" | "audio" | "video" | "document";

export function mimeForFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

export function mediaTypeForMime(mimeType: string): OutboundMediaType {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  return "document";
}

/** True when the string is already a URL Meta can fetch by itself. */
export function isRemoteMediaUrl(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

/**
 * Turn whatever the runtime handed us into a local filesystem path.
 * Accepts absolute paths, file:// URLs and ~-relative paths. `~` is expanded
 * here because OpenClaw renders paths in that form and a model may copy it.
 */
/**
 * Collapse a reply payload's media fields into one de-duplicated list.
 *
 * The runtime sets `mediaUrls` to the full list AND `mediaUrl` to its first
 * entry, so a single attachment arrives in both fields. Handling each field in
 * turn uploaded and delivered the same photo twice.
 */
export function mediaUrlsFromPayload(payload: {
  mediaUrl?: string | null;
  mediaUrls?: readonly string[] | null;
}): string[] {
  const list =
    Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length
      ? payload.mediaUrls
      : payload?.mediaUrl
        ? [payload.mediaUrl]
        : [];
  return [...new Set(list.filter((u): u is string => typeof u === "string" && u.trim().length > 0))];
}

export function resolveLocalMediaPath(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/**
 * Send media that may be either a public URL or a local file.
 *
 * Remote URLs keep the cheap `link` path. Local files are read, uploaded to
 * Meta's media store, then sent by id.
 */
export async function sendOutboundMedia(
  config: WhatsAppCloudConfig,
  to: string,
  source: string,
  caption: string | undefined,
  log: Logger
): Promise<SendResult> {
  if (isRemoteMediaUrl(source)) {
    const mimeType = mimeForFileName(source.split("?")[0]);
    return sendMedia(
      config,
      to,
      mediaTypeForMime(mimeType),
      { link: source.trim(), caption: caption || undefined },
      log
    );
  }

  const path = resolveLocalMediaPath(source);
  const fileName = basename(path);
  const mimeType = mimeForFileName(fileName);
  const mediaType = mediaTypeForMime(mimeType);

  let data: Uint8Array;
  try {
    data = await readFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`[whatsapp-cloud] Cannot read local media ${path}: ${reason}`);
    return { ok: false, error: `local media file unreadable: ${path}` };
  }

  const uploaded = await uploadMedia(config, { data, fileName, mimeType }, log);
  if (!uploaded.ok || !uploaded.mediaId) {
    return { ok: false, error: uploaded.error ?? "media upload failed" };
  }

  return sendMedia(
    config,
    to,
    mediaType,
    {
      id: uploaded.mediaId,
      // Only image, video and document carry a caption; audio does not.
      ...(mediaType === "audio" ? {} : { caption: caption || undefined }),
      ...(mediaType === "document" ? { filename: fileName } : {}),
    },
    log
  );
}
