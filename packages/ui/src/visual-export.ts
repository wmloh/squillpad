import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  elementBounds,
  elementsByZ,
  textBoxGroupBounds,
  type CanvasBounds,
  type CanvasElement,
  type ImageCanvasRecord,
  type InkCanvasRecord,
  type ShapeCanvasRecord,
} from "@squillpad/core-model";

import { renderInkPath } from "./ink-engine";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** Options for a vector scene export. */
export interface SvgExportOptions {
  readonly elements: readonly CanvasElement[];
  readonly markdownSources?: Readonly<Record<string, string>>;
  readonly markdownHtml?: Readonly<Record<string, string>>;
  readonly imageSources?: Readonly<Record<string, string>>;
  readonly markdownFontSize?: number;
  readonly theme?: "light" | "dark";
  readonly selectedIds?: ReadonlySet<string>;
  readonly region?: CanvasBounds;
  readonly padding?: number;
  readonly background?: string | null;
  readonly scale?: number;
}

/** A serialized SVG plus the world-space region and raster dimensions it represents. */
export interface SvgExportResult {
  readonly svg: string;
  readonly bounds: CanvasBounds;
  readonly width: number;
  readonly height: number;
}

/** The result of rasterizing an SVG scene for an ordinary image application. */
export interface PngExportResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/** Minimal file contract used by the browser Markdown importer. */
export interface MarkdownFileLike {
  readonly name: string;
  readonly text: () => Promise<string>;
}

/** Reads Markdown as text without normalizing syntax, line endings, or relative asset paths. */
export async function readMarkdownFile(file: MarkdownFileLike): Promise<string> {
  return file.text();
}

/**
 * Serializes selected or full-page canvas objects without changing their canonical coordinates.
 *
 * Markdown uses rendered DOM HTML when supplied by the live editor. If a block is off-screen or
 * no rendered HTML is available, its original source is shown in a readable `<pre>` fallback;
 * this keeps math delimiters and unsupported Markdown visible rather than silently dropping them.
 */
export function exportPageToSvg(options: SvgExportOptions): SvgExportResult {
  const scale = positiveScale(options.scale ?? 1);
  const theme = options.theme ?? "light";
  const markdownFontSize = positiveNumber(options.markdownFontSize ?? DEFAULT_MARKDOWN_FONT_SIZE);
  const sourceElements = options.selectedIds
    ? options.elements.filter((element) => options.selectedIds?.has(element.id))
    : [...options.elements];
  const elements = elementsByZ(sourceElements);
  const textGroups = textGroupFrames(sourceElements);
  const content = unionBounds([
    ...elements.map(elementBounds),
    ...textGroups.map((group) => group.bounds),
  ]);
  const padding = Math.max(0, options.padding ?? 16);
  const bounds = options.region ?? paddedBounds(content, padding);
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  const markdownSources = options.markdownSources ?? {};
  const markdownHtml = options.markdownHtml ?? {};
  const imageSources = options.imageSources ?? {};
  const background =
    options.background === null
      ? ""
      : `<rect width="100%" height="100%" fill="${xmlAttribute(options.background ?? (theme === "dark" ? "#080909" : "#ffffff"))}"/>`;
  const scene = [
    ...textGroups.map((group) => serializeTextGroupFrame(group.id, group.bounds, bounds, theme)),
    ...elements.map((element) =>
      serializeElement(element, bounds, markdownSources, markdownHtml, imageSources),
    ),
  ].join("");

  return {
    svg: [
      `<svg xmlns="${SVG_NAMESPACE}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
      `<style>${exportStyles(theme, markdownFontSize)}</style>`,
      background,
      `<g transform="scale(${numberValue(scale)})">${scene}</g>`,
      "</svg>",
    ].join(""),
    bounds,
    width,
    height,
  };
}

function textGroupFrames(elements: readonly CanvasElement[]) {
  const ids = new Set(
    elements.flatMap((element) =>
      element.kind === "markdown" && element.textGroupId !== undefined ? [element.textGroupId] : [],
    ),
  );
  return [...ids].flatMap((id) => {
    const bounds = textBoxGroupBounds(elements, id);
    return bounds === undefined ? [] : [{ bounds, id }];
  });
}

function serializeTextGroupFrame(
  id: string,
  frame: CanvasBounds,
  region: CanvasBounds,
  theme: "light" | "dark",
): string {
  const x = frame.x - region.x;
  const y = frame.y - region.y;
  const start = theme === "dark" ? "#536a60" : "#d8deea";
  const highlight = theme === "dark" ? "#b6e0c5" : "#89b9ef";
  return `<defs><linearGradient id="text-group-${id}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${start}" stop-opacity="0.38"/><stop offset="0.32" stop-color="${highlight}" stop-opacity="0.9"/><stop offset="0.7" stop-color="${start}" stop-opacity="0.42"/><stop offset="1" stop-color="${highlight}" stop-opacity="0.74"/></linearGradient><filter id="text-group-glow-${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="${numberValue(x)}" y="${numberValue(y)}" width="${numberValue(frame.width)}" height="${numberValue(frame.height)}" rx="18" fill="none" stroke="url(#text-group-${id})" stroke-width="1.5" filter="url(#text-group-glow-${id})"/>`;
}

/** Converts a serialized SVG scene to a PNG in browsers that provide a canvas element. */
export async function rasterizeSvgToPng(
  exported: SvgExportResult,
  scale = 1,
): Promise<PngExportResult> {
  const rasterScale = positiveScale(scale);
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("PNG export requires a browser canvas");
  }

  const width = Math.max(1, Math.ceil(exported.width * rasterScale));
  const height = Math.max(1, Math.ceil(exported.height * rasterScale));
  const canvasSafeSvg = sanitizeSvgForCanvas(exported.svg, true);
  const url = URL.createObjectURL(new Blob([canvasSafeSvg], { type: "image/svg+xml" }));
  try {
    return {
      blob: await rasterizeSvgUrl(url, width, height),
      width,
      height,
    };
  } catch (error) {
    if (!isCanvasSecurityError(error)) throw error;

    // Retry through a data URL after removing every external resource for older engines.
    return {
      blob: await rasterizeSvgUrl(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvgForCanvas(exported.svg, false))}`,
        width,
        height,
      ),
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Starts a browser download for text, SVG, or PNG export data. */
export function downloadExport(
  filename: string,
  contents: string | Blob,
  mimeType = "application/octet-stream",
): void {
  if (typeof document === "undefined") return;
  const blob = typeof contents === "string" ? new Blob([contents], { type: mimeType }) : contents;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function serializeElement(
  element: CanvasElement,
  region: CanvasBounds,
  markdownSources: Readonly<Record<string, string>>,
  markdownHtml: Readonly<Record<string, string>>,
  imageSources: Readonly<Record<string, string>>,
): string {
  if (element.kind === "markdown") {
    return serializeMarkdown(
      element,
      region,
      markdownSources[element.id] ?? "",
      markdownHtml[element.id],
    );
  }
  if (element.kind === "image") return serializeImage(element, region, imageSources[element.asset]);
  if (element.kind === "ink") return serializeInk(element, region);
  return serializeShape(element, region);
}

function serializeMarkdown(
  element: CanvasElement & { readonly kind: "markdown" },
  region: CanvasBounds,
  source: string,
  renderedHtml: string | undefined,
): string {
  const x = element.position[0] - region.x;
  const y = element.position[1] - region.y;
  const content =
    renderedHtml === undefined
      ? `<pre class="markdown-export-source">${escapeXml(source)}</pre>`
      : `<div class="markdown-export-content">${normalizeForeignObjectHtml(renderedHtml)}</div>`;
  return `<foreignObject x="${numberValue(x)}" y="${numberValue(y)}" width="${numberValue(element.width)}" height="${numberValue(element.height)}"><div xmlns="${XHTML_NAMESPACE}" class="markdown-export-block">${content}</div></foreignObject>`;
}

function serializeInk(element: InkCanvasRecord, region: CanvasBounds): string {
  const bounds = elementBounds(element);
  const x = bounds.x - region.x;
  const y = bounds.y - region.y;
  const path = renderInkPath(element, bounds);
  return `<path transform="translate(${numberValue(x)} ${numberValue(y)})" d="${xmlAttribute(path)}" fill="${xmlAttribute(element.style.color)}" opacity="${numberValue(element.style.opacity)}"/>`;
}

function serializeImage(element: ImageCanvasRecord, region: CanvasBounds, source?: string): string {
  const x = element.position[0] - region.x;
  const y = element.position[1] - region.y;
  return `<image x="${numberValue(x)}" y="${numberValue(y)}" width="${numberValue(element.width)}" height="${numberValue(element.height)}" href="${xmlAttribute(source ?? element.asset)}" preserveAspectRatio="none"/>`;
}

function serializeShape(element: ShapeCanvasRecord, region: CanvasBounds): string {
  const bounds = elementBounds(element);
  const x = bounds.x - region.x;
  const y = bounds.y - region.y;
  const style = element.style;
  const geometry = element.geometry;
  if (geometry.kind === "line" || geometry.kind === "arrow") {
    const marker =
      geometry.kind === "arrow"
        ? `<defs><marker id="export-arrow-${element.id}" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 5 2.5 L 0 5 Z" fill="${xmlAttribute(style.strokeColor)}"/></marker></defs>`
        : "";
    return `<g transform="translate(${numberValue(x)} ${numberValue(y)})">${marker}<line x1="${numberValue(element.position[0] + geometry.start[0] - bounds.x)}" y1="${numberValue(element.position[1] + geometry.start[1] - bounds.y)}" x2="${numberValue(element.position[0] + geometry.end[0] - bounds.x)}" y2="${numberValue(element.position[1] + geometry.end[1] - bounds.y)}" stroke="${xmlAttribute(style.strokeColor)}" stroke-width="${numberValue(style.strokeWidth)}" opacity="${numberValue(style.opacity)}"${geometry.kind === "arrow" ? ` marker-end="url(#export-arrow-${element.id})"` : ""}/></g>`;
  }
  const fill = style.fillColor === null ? "none" : xmlAttribute(style.fillColor);
  if (geometry.kind === "rectangle") {
    return `<rect x="${numberValue(x + style.strokeWidth / 2)}" y="${numberValue(y + style.strokeWidth / 2)}" width="${numberValue(Math.max(0, geometry.width - style.strokeWidth))}" height="${numberValue(Math.max(0, geometry.height - style.strokeWidth))}" fill="${fill}" stroke="${xmlAttribute(style.strokeColor)}" stroke-width="${numberValue(style.strokeWidth)}" opacity="${numberValue(style.opacity)}"/>`;
  }
  return `<ellipse cx="${numberValue(x + bounds.width / 2)}" cy="${numberValue(y + bounds.height / 2)}" rx="${numberValue(Math.max(0, geometry.width - style.strokeWidth) / 2)}" ry="${numberValue(Math.max(0, geometry.height - style.strokeWidth) / 2)}" fill="${fill}" stroke="${xmlAttribute(style.strokeColor)}" stroke-width="${numberValue(style.strokeWidth)}" opacity="${numberValue(style.opacity)}"/>`;
}

function unionBounds(bounds: readonly CanvasBounds[]): CanvasBounds | undefined {
  if (bounds.length === 0) return undefined;
  const minX = Math.min(...bounds.map((value) => value.x));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function paddedBounds(bounds: CanvasBounds | undefined, padding: number): CanvasBounds {
  if (bounds === undefined) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
  };
}

function exportStyles(theme: "light" | "dark", markdownFontSize: number): string {
  const colors =
    theme === "dark"
      ? {
          blockBackground: "#222322",
          blockBorder: "#3e433f",
          codeBackground: "#282b29",
          link: "#afd0bb",
          muted: "#a4a7a1",
          tableBorder: "#3a3d39",
          text: "#eceeea",
          quoteBorder: "#80ae96",
        }
      : {
          blockBackground: "#fff",
          blockBorder: "#d7d0e0",
          codeBackground: "#f2eff6",
          link: "#573690",
          muted: "#62596c",
          tableBorder: "#d8d1e0",
          text: "#27252b",
          quoteBorder: "#c7b9dc",
        };
  return [
    `.markdown-export-block{box-sizing:border-box;width:100%;height:100%;padding:13px;border:1px solid ${colors.blockBorder};border-radius:4px;background:${colors.blockBackground};color:${colors.text};font:${numberValue(markdownFontSize)}px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden}`,
    ".markdown-export-content{overflow:hidden;overflow-wrap:anywhere}",
    ".markdown-export-content>:first-child{margin-top:0}.markdown-export-content>:last-child{margin-bottom:0}",
    `.markdown-export-content pre,.markdown-export-content code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:${colors.codeBackground};border-radius:3px}.markdown-export-content pre{padding:10px;overflow:hidden}.markdown-export-content code{padding:1px 3px}`,
    `.markdown-export-content blockquote{margin-left:0;padding-left:10px;border-left:3px solid ${colors.quoteBorder};color:${colors.muted}}.markdown-export-content a{color:${colors.link}}.markdown-export-content table{width:100%;border-collapse:collapse}.markdown-export-content th,.markdown-export-content td{padding:4px 7px;border:1px solid ${colors.tableBorder};text-align:left}`,
    ".markdown-export-source{box-sizing:border-box;width:100%;height:100%;margin:0;white-space:pre-wrap;overflow:hidden;font:15px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}",
    ".katex{font-size:1em;line-height:1.2}.katex-display{display:block;margin:1em 0;overflow:hidden;text-align:center}.katex-display>.katex{display:inline-block}.katex-error{color:#a3203e}",
  ].join("");
}

function normalizeForeignObjectHtml(html: string): string {
  return html
    .replaceAll("&nbsp;", "&#160;")
    .replaceAll("&copy;", "&#169;")
    .replaceAll("&times;", "&#215;")
    .replace(
      /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\b[^>]*)>/gi,
      (match: string, tag: string, attributes: string) =>
        match.endsWith("/>") ? match : `<${tag}${attributes} />`,
    );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlAttribute(value: string): string {
  return escapeXml(value);
}

function numberValue(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function positiveScale(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function positiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MARKDOWN_FONT_SIZE;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("PNG export could not decode the SVG scene"));
    image.src = url;
  });
}

async function rasterizeSvgUrl(url: string, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("PNG export could not create a 2D canvas");
  const image = await loadImage(url);
  context.drawImage(image, 0, 0, width, height);
  return canvasBlob(canvas);
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("PNG export could not encode the canvas"));
      else resolve(blob);
    }, "image/png");
  });
}

function sanitizeSvgForCanvas(svg: string, preserveSameOriginResources: boolean): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return stripExternalResourceTags(svg);
  }

  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror") !== null) return stripExternalResourceTags(svg);

  for (const resource of parsed.querySelectorAll(
    "img, image, video, audio, iframe, object, embed, link",
  )) {
    const source =
      resource.getAttribute("src") ??
      resource.getAttribute("href") ??
      resource.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (source === null || !isCanvasSafeResource(source, preserveSameOriginResources)) {
      resource.remove();
    }
  }
  for (const element of parsed.querySelectorAll("[style]")) {
    if (/\burl\s*\(/i.test(element.getAttribute("style") ?? "")) {
      element.removeAttribute("style");
    }
  }
  for (const style of parsed.querySelectorAll("style")) {
    if (/\burl\s*\(/i.test(style.textContent ?? "")) style.remove();
  }
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function isCanvasSafeResource(source: string, preserveSameOriginResources: boolean): boolean {
  if (/^data:image\/(?:png|jpe?g|gif|webp);/i.test(source)) return true;
  if (!preserveSameOriginResources) return false;
  try {
    const resolved = new URL(source, document.baseURI);
    return resolved.origin === window.location.origin;
  } catch {
    return false;
  }
}

function stripExternalResourceTags(svg: string): string {
  return svg.replace(
    /<(img|image|video|audio|iframe|object|embed|link)\b[^>]*(?:\/?>[\s\S]*?<\/\1\s*>|\/?>)/gi,
    "",
  );
}

function isCanvasSecurityError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "SecurityError") ||
    (error instanceof Error && /tainted|origin-clean|securityerror/i.test(error.message))
  );
}
