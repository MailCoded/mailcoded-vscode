import type { MailcodedClient } from "../daemon/types.js";
import type { AttachmentDto } from "../protocol/index.js";

export const INLINE_IMAGE_LIMIT = 10;
export const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/webp",
]);

const CONTENT_ID_MAX = 200;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTENT_ID_KEEP = /^[\p{L}\p{N}._%+@!$&*=~-]+$/u;

export interface InlineImageSet {
  /** `cid` → `data:` URI, keyed both bare and angle-bracketed: real mail writes it both ways. */
  readonly images: Readonly<Record<string, string>>;
  readonly resolved: number;
  readonly skipped: number;
}

export const NO_INLINE_IMAGES: InlineImageSet = { images: {}, resolved: 0, skipped: 0 };

/** Base64 is also what the daemon hands back for a saved attachment, so the charset check lives
 * here and both callers share it. */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64.test(value);
}

/** A `Content-Type` carries parameters and arbitrary case; only the four exact types below may
 * ever reach a `data:` URI, and the canonical spelling is what gets written. */
function canonicalMime(mime: string | undefined): string | undefined {
  if (typeof mime !== "string") {
    return undefined;
  }
  const bare = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return INLINE_MIME_TYPES.has(bare) ? bare : undefined;
}

/** Angle brackets are the RFC 2392 form; anything else non-trivial is refused rather than
 * cleaned, because the cid becomes a lookup key the webview matches an `img src` against. */
function contentId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (bare === "" || bare.length > CONTENT_ID_MAX || !CONTENT_ID_KEEP.test(bare)) {
    return undefined;
  }
  return bare;
}

export interface InlineImageCandidate {
  readonly index: number;
  readonly cid: string;
  readonly mime: string;
}

export function inlineImageCandidates(
  attachments: readonly AttachmentDto[],
): readonly InlineImageCandidate[] {
  const seen = new Set<string>();
  const candidates: InlineImageCandidate[] = [];

  for (const attachment of attachments) {
    if (candidates.length >= INLINE_IMAGE_LIMIT) {
      break;
    }
    const mime = canonicalMime(attachment.mime);
    const cid = contentId(attachment.contentId);
    const oversize = !Number.isFinite(attachment.size) || attachment.size > INLINE_IMAGE_MAX_BYTES;
    if (!attachment.isInline || mime === undefined || cid === undefined || oversize) {
      continue;
    }
    if (seen.has(cid) || !Number.isSafeInteger(attachment.index) || attachment.index < 0) {
      continue;
    }
    seen.add(cid);
    candidates.push({ index: attachment.index, cid, mime });
  }

  return candidates;
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Inline parts become `data:` URIs so a message shows its own images without the CSP naming any
 * origin. One failure is skipped, never raised: a broken part must not cost the whole render. */
export async function resolveInlineImages(
  client: MailcodedClient,
  messageId: number,
  attachments: readonly AttachmentDto[],
): Promise<InlineImageSet> {
  const candidates = inlineImageCandidates(attachments);
  if (candidates.length === 0) {
    return NO_INLINE_IMAGES;
  }

  const images: Record<string, string> = {};
  let resolved = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    let base64: string;
    let mime: string | undefined;
    try {
      const blob = await client.request("attachment.get", { messageId, index: candidate.index });
      base64 = typeof blob.base64 === "string" ? blob.base64 : "";
      mime = canonicalMime(blob.mime);
    } catch {
      skipped += 1;
      continue;
    }

    if (
      mime === undefined ||
      base64 === "" ||
      !isBase64(base64) ||
      decodedLength(base64) > INLINE_IMAGE_MAX_BYTES
    ) {
      skipped += 1;
      continue;
    }

    const dataUri = `data:${mime};base64,${base64}`;
    images[candidate.cid] = dataUri;
    images[`<${candidate.cid}>`] = dataUri;
    resolved += 1;
  }

  return { images, resolved, skipped };
}
