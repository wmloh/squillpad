import { validateCanvasRecords } from "@squillpad/core-model";
import type { PageSnapshot } from "./canvas-history";

const FORMAT = "squillpad/canvas-v2";
const IMAGE_MIME_PATTERN = /^image\/(?:png|jpe?g|gif|webp)$/i;

export interface ClipboardImage {
  readonly blob: Blob;
  readonly height: number;
  readonly width: number;
}

export function encodeClipboard(snapshot: PageSnapshot): string {
  return JSON.stringify({ format: FORMAT, ...snapshot });
}

/** Reports whether a clipboard image uses a supported embedded raster format. */
export function isSupportedClipboardImageType(type: string): boolean {
  return IMAGE_MIME_PATTERN.test(type);
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Decodes a raster and downscales oversized non-GIF data before upload. */
export async function readClipboardImage(file: Blob): Promise<ClipboardImage> {
  if (!isSupportedClipboardImageType(file.type)) throw new Error("Unsupported clipboard image");
  if (file.size > MAX_IMAGE_BYTES && /image\/gif/i.test(file.type)) {
    throw new Error("Animated GIF exceeds the 25 MiB limit");
  }
  const image = await decodeImage(file);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) throw new Error("Clipboard image has no intrinsic dimensions");
  if (file.size <= MAX_IMAGE_BYTES) return { blob: file, height, width };
  let scale = Math.min(0.95, Math.sqrt(MAX_IMAGE_BYTES / file.size) * 0.95);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Browser image compression is unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, file.type);
    if (blob.size <= MAX_IMAGE_BYTES) return { blob, height, width };
    scale *= 0.8;
  }
  throw new Error("Compressed image still exceeds the 25 MiB limit");
}

function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Clipboard image could not be decoded"));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Image compression failed")) : resolve(blob)),
      type,
      0.92,
    ),
  );
}

/** Accepts only canonical objects and their corresponding Markdown sources. */
export function decodeClipboard(text: string): PageSnapshot | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value === null || value.format !== FORMAT) return;
    const result = validateCanvasRecords(value.elements);
    if (!result.success || value.sources === null || typeof value.sources !== "object") return;
    const sources = value.sources as Record<string, unknown>;
    const entries: [string, string][] = [];
    const imageData = value.imageData as Record<string, unknown> | undefined;
    const imageEntries: [string, string][] = [];
    for (const element of result.data) {
      if (element.kind === "markdown") {
        const source = sources[element.id];
        if (typeof source !== "string") return;
        entries.push([element.id, source]);
      }
      if (element.kind === "image") {
        const data = imageData?.[element.id];
        if (typeof data !== "string" || !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(data))
          return;
        imageEntries.push([element.id, data]);
      }
    }
    return {
      elements: result.data,
      sources: Object.fromEntries(entries),
      ...(imageEntries.length === 0 ? {} : { imageData: Object.fromEntries(imageEntries) }),
    };
  } catch {
    return;
  }
}
