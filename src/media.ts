// ---------------------------------------------------------------------------
// Inbound media persistence — download WhatsApp media to a local temp file so
// the agent runtime can process it (audio transcription via {{MediaPath}},
// image understanding, documents).
//
// PinkLime fork addition: upstream parses media metadata but never downloads
// the binary, which leaves voice notes as "[🎵 Audio message]" placeholders.
// ---------------------------------------------------------------------------

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMediaUrl, downloadMedia } from "./api.js";
import type { WhatsAppCloudConfig, Logger } from "./types.js";
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
