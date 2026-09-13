/** Current canonical project schema version. */
export const CANONICAL_SCHEMA_VERSION = 2 as const;

export const CANONICAL_COORDINATE_DECIMALS = 3;
export const CANONICAL_STYLE_DECIMALS = 4;

const STABLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKDOWN_SOURCE_PATTERN = /^markdown\/[0-9a-f-]+\.md$/;
const IMAGE_ASSET_PATTERN = /^assets\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type CanonicalMetadata = Readonly<Record<string, JsonValue>>;

export interface NotebookSettings {
  readonly defaultZoom: number;
  readonly metadata: CanonicalMetadata;
}

export interface NotebookManifest {
  readonly schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  readonly projectId: string;
  readonly title: string;
  readonly sectionIds: readonly string[];
  readonly settings: NotebookSettings;
}

export interface SectionManifest {
  readonly schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly pageIds: readonly string[];
  readonly metadata: CanonicalMetadata;
}

export interface PageManifest {
  readonly schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly metadata: CanonicalMetadata;
}

export type CanonicalPoint = readonly [x: number, y: number];

interface CanvasRecordBase {
  readonly id: string;
  readonly groupId?: string;
  readonly position: CanonicalPoint;
  readonly z: number;
}

export interface MarkdownCanvasRecord extends CanvasRecordBase {
  readonly kind: "markdown";
  readonly textGroupId?: string;
  readonly markdownStyleId?: string;
  readonly width: number;
  readonly height: number;
  readonly source: string;
}

export interface ImageCanvasRecord extends CanvasRecordBase {
  readonly kind: "image";
  readonly width: number;
  readonly height: number;
  readonly asset: string;
}

export type InkPoint = CanonicalPoint;

export interface InkStyle {
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
  readonly highlighter: boolean;
  readonly smoothing?: number;
}

export interface InkCanvasRecord extends CanvasRecordBase {
  readonly kind: "ink";
  readonly points: readonly InkPoint[];
  readonly style: InkStyle;
}

export interface LineGeometry {
  readonly kind: "line";
  readonly start: CanonicalPoint;
  readonly end: CanonicalPoint;
}

export interface ArrowGeometry {
  readonly kind: "arrow";
  readonly start: CanonicalPoint;
  readonly end: CanonicalPoint;
}

export interface RectangleGeometry {
  readonly kind: "rectangle";
  readonly width: number;
  readonly height: number;
}

export interface EllipseGeometry {
  readonly kind: "ellipse";
  readonly width: number;
  readonly height: number;
}

export type BoundedShapeGeometry = RectangleGeometry | EllipseGeometry;
export type ShapeGeometry = LineGeometry | ArrowGeometry | BoundedShapeGeometry;

export interface ShapeStyle {
  readonly strokeColor: string;
  readonly strokeWidth: number;
  readonly fillColor: string | null;
  readonly opacity: number;
}

export interface ShapeCanvasRecord extends CanvasRecordBase {
  readonly kind: "shape";
  readonly geometry: ShapeGeometry;
  readonly style: ShapeStyle;
}

export type CanvasRecord =
  | MarkdownCanvasRecord
  | ImageCanvasRecord
  | InkCanvasRecord
  | ShapeCanvasRecord;

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export type CanonicalDocumentKind = "notebook" | "section" | "page" | "canvas";

/** One adjacent, non-destructive canonical schema migration. */
export interface CanonicalMigrationStep {
  readonly documentKind: CanonicalDocumentKind;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (document: unknown) => unknown;
}

/** Ordered adjacent migration steps, executed from lowest to highest version. */
export type CanonicalMigrationRegistry = readonly CanonicalMigrationStep[];

/** Quantizes a world coordinate to its canonical precision and removes negative zero. */
export function canonicalCoordinate(value: number): number {
  return roundCanonicalNumber(value, CANONICAL_COORDINATE_DECIMALS);
}

/** Validates a root notebook manifest without coercing input. */
export function validateNotebookManifest(value: unknown): ValidationResult<NotebookManifest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalidRoot("notebook manifest must be an object");
  }

  exactKeys(value, ["projectId", "schemaVersion", "sectionIds", "settings", "title"], "$", issues);
  schemaVersion(value.schemaVersion, "$.schemaVersion", issues);
  stableId(value.projectId, "$.projectId", issues);
  stringValue(value.title, "$.title", issues);
  uniqueStableIds(value.sectionIds, "$.sectionIds", issues);
  notebookSettings(value.settings, "$.settings", issues);
  return result<NotebookManifest>(value, issues);
}

/** Validates a section manifest without coercing input. */
export function validateSectionManifest(value: unknown): ValidationResult<SectionManifest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalidRoot("section manifest must be an object");
  }

  exactKeys(value, ["id", "metadata", "pageIds", "schemaVersion", "title"], "$", issues);
  schemaVersion(value.schemaVersion, "$.schemaVersion", issues);
  stableId(value.id, "$.id", issues);
  stringValue(value.title, "$.title", issues);
  uniqueStableIds(value.pageIds, "$.pageIds", issues);
  metadata(value.metadata, "$.metadata", issues);
  return result<SectionManifest>(value, issues);
}

/** Validates a page manifest without coercing input. */
export function validatePageManifest(value: unknown): ValidationResult<PageManifest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalidRoot("page manifest must be an object");
  }

  exactKeys(value, ["id", "metadata", "schemaVersion", "title"], "$", issues);
  schemaVersion(value.schemaVersion, "$.schemaVersion", issues);
  stableId(value.id, "$.id", issues);
  stringValue(value.title, "$.title", issues);
  metadata(value.metadata, "$.metadata", issues);
  return result<PageManifest>(value, issues);
}

/** Validates one independently identified canvas JSONL record. */
export function validateCanvasRecord(value: unknown): ValidationResult<CanvasRecord> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalidRoot("canvas record must be an object");
  }

  stableId(value.id, "$.id", issues);
  point(value.position, "$.position", issues);
  integer(value.z, "$.z", issues);
  if (value.groupId !== undefined) stableId(value.groupId, "$.groupId", issues);
  if (value.kind === "markdown") {
    exactKeys(value, ["height", "id", "kind", "position", "source", "width", "z"], "$", issues, [
      "groupId",
      "textGroupId",
      "markdownStyleId",
    ]);
    if (value.textGroupId !== undefined) stableId(value.textGroupId, "$.textGroupId", issues);
    if (value.markdownStyleId !== undefined)
      stableId(value.markdownStyleId, "$.markdownStyleId", issues);
    positiveCoordinate(value.width, "$.width", issues);
    positiveCoordinate(value.height, "$.height", issues);
    markdownSource(value.source, value.id, "$.source", issues);
  } else if (value.kind === "ink") {
    exactKeys(value, ["id", "kind", "points", "position", "style", "z"], "$", issues, ["groupId"]);
    inkPoints(value.points, "$.points", issues);
    inkStyle(value.style, "$.style", issues);
  } else if (value.kind === "shape") {
    exactKeys(value, ["geometry", "id", "kind", "position", "style", "z"], "$", issues, [
      "groupId",
    ]);
    shapeGeometry(value.geometry, "$.geometry", issues);
    shapeStyle(value.style, "$.style", issues);
  } else if (value.kind === "image") {
    exactKeys(value, ["asset", "height", "id", "kind", "position", "width", "z"], "$", issues, [
      "groupId",
    ]);
    positiveCoordinate(value.width, "$.width", issues);
    positiveCoordinate(value.height, "$.height", issues);
    imageAsset(value.asset, "$.asset", issues);
  } else {
    issues.push({ path: "$.kind", message: "must be markdown, image, ink, or shape" });
  }
  return result<CanvasRecord>(value, issues);
}

/** Validates a complete canvas collection, including permanent ID uniqueness. */
export function validateCanvasRecords(value: unknown): ValidationResult<readonly CanvasRecord[]> {
  if (!Array.isArray(value)) {
    return invalidRoot("canvas records must be an array");
  }

  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  value.forEach((record, index) => {
    const recordResult = validateCanvasRecord(record);
    if (!recordResult.success) {
      for (const issue of recordResult.issues) {
        issues.push({ path: `$[${index}]${issue.path.slice(1)}`, message: issue.message });
      }
    }
    if (isRecord(record) && typeof record.id === "string") {
      if (seen.has(record.id)) {
        issues.push({ path: `$[${index}].id`, message: "must not duplicate another object ID" });
      }
      seen.add(record.id);
    }
  });
  return result<readonly CanvasRecord[]>(value, issues);
}

/** Serializes a structured canonical file with sorted keys, two-space indentation, and one LF. */
export function serializeCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

/** Serializes canvas records in stable z/ID order with one compact object per LF line. */
export function serializeCanvasJsonLines(records: readonly CanvasRecord[]): string {
  const ordered = [...records].sort(
    (left, right) => left.z - right.z || compareCodeUnits(left.id, right.id),
  );
  const lines = ordered.map((record) => JSON.stringify(sortJsonValue(record))).join("\n");
  return lines.length > 0 ? `${lines}\n` : "";
}

/** Measures the UTF-8 bytes occupied by the canonical canvas JSONL representation. */
export function measureCanonicalCanvasBytes(records: readonly CanvasRecord[]): number {
  return new TextEncoder().encode(serializeCanvasJsonLines(records)).byteLength;
}

/** Measures each canonical canvas record as an independent JSONL line. */
export function measureCanonicalCanvasRecordBytes(
  records: readonly CanvasRecord[],
): Readonly<Record<string, number>> {
  const ordered = [...records].sort(
    (left, right) => left.z - right.z || compareCodeUnits(left.id, right.id),
  );
  return Object.fromEntries(
    ordered.map((record) => [
      record.id,
      new TextEncoder().encode(`${JSON.stringify(sortJsonValue(record))}\n`).byteLength,
    ]),
  );
}

function result<T>(value: unknown, issues: readonly ValidationIssue[]): ValidationResult<T> {
  return issues.length === 0 ? { success: true, data: value as T } : { success: false, issues };
}

function invalidRoot<T>(message: string): ValidationResult<T> {
  return { success: false, issues: [{ path: "$", message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: ValidationIssue[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key) && !optional.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "is not a recognized field in this schema version",
      });
    }
  }
  for (const key of expected) {
    if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "is required" });
  }
}

function schemaVersion(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value !== CANONICAL_SCHEMA_VERSION) {
    issues.push({ path, message: `must equal ${CANONICAL_SCHEMA_VERSION}` });
  }
}

function stableId(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    issues.push({ path, message: "must be a lowercase RFC 4122 UUID" });
  }
}

function stringValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string") issues.push({ path, message: "must be a string" });
}

function uniqueStableIds(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  const seen = new Set<string>();
  value.forEach((id, index) => {
    stableId(id, `${path}[${index}]`, issues);
    if (typeof id === "string" && seen.has(id)) {
      issues.push({ path: `${path}[${index}]`, message: "must not duplicate another ID" });
    }
    if (typeof id === "string") seen.add(id);
  });
}

function notebookSettings(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["defaultZoom", "metadata"], path, issues);
  positiveStyleNumber(value.defaultZoom, `${path}.defaultZoom`, issues);
  metadata(value.metadata, `${path}.metadata`, issues);
}

function metadata(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value) || !isJsonValue(value)) {
    issues.push({ path, message: "must be a JSON object containing only finite numbers" });
  }
}

function point(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 2) {
    issues.push({ path, message: "must be an [x, y] tuple" });
    return;
  }
  coordinate(value[0], `${path}[0]`, issues);
  coordinate(value[1], `${path}[1]`, issues);
}

function inkPoints(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "must be a non-empty array" });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    point(item, itemPath, issues);
  });
}

function inkStyle(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["color", "highlighter", "opacity", "width"], path, issues, ["smoothing"]);
  stringValue(value.color, `${path}.color`, issues);
  positiveCoordinate(value.width, `${path}.width`, issues);
  unitStyleNumber(value.opacity, `${path}.opacity`, issues);
  if (typeof value.highlighter !== "boolean") {
    issues.push({ path: `${path}.highlighter`, message: "must be a boolean" });
  }
  if (value.smoothing !== undefined) unitStyleNumber(value.smoothing, `${path}.smoothing`, issues);
}

function shapeGeometry(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  if (value.kind === "line" || value.kind === "arrow") {
    exactKeys(value, ["end", "kind", "start"], path, issues);
    point(value.start, `${path}.start`, issues);
    point(value.end, `${path}.end`, issues);
  } else if (value.kind === "rectangle" || value.kind === "ellipse") {
    exactKeys(value, ["height", "kind", "width"], path, issues);
    positiveCoordinate(value.width, `${path}.width`, issues);
    positiveCoordinate(value.height, `${path}.height`, issues);
  } else {
    issues.push({ path: `${path}.kind`, message: "must be line, arrow, rectangle, or ellipse" });
  }
}

function shapeStyle(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["fillColor", "opacity", "strokeColor", "strokeWidth"], path, issues);
  stringValue(value.strokeColor, `${path}.strokeColor`, issues);
  positiveCoordinate(value.strokeWidth, `${path}.strokeWidth`, issues);
  if (value.fillColor !== null) stringValue(value.fillColor, `${path}.fillColor`, issues);
  unitStyleNumber(value.opacity, `${path}.opacity`, issues);
}

function integer(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.push({ path, message: "must be a safe integer" });
  }
}

function coordinate(value: unknown, path: string, issues: ValidationIssue[]): void {
  preciseNumber(value, path, CANONICAL_COORDINATE_DECIMALS, issues);
}

function positiveCoordinate(value: unknown, path: string, issues: ValidationIssue[]): void {
  coordinate(value, path, issues);
  if (typeof value === "number" && value <= 0) {
    issues.push({ path, message: "must be greater than zero" });
  }
}

function positiveStyleNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  preciseNumber(value, path, CANONICAL_STYLE_DECIMALS, issues);
  if (typeof value === "number" && value <= 0) {
    issues.push({ path, message: "must be greater than zero" });
  }
}

function unitStyleNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  preciseNumber(value, path, CANONICAL_STYLE_DECIMALS, issues);
  if (typeof value === "number" && (value < 0 || value > 1)) {
    issues.push({ path, message: "must be between zero and one" });
  }
}

function preciseNumber(
  value: unknown,
  path: string,
  decimals: number,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "must be a finite number" });
  } else if (roundCanonicalNumber(value, decimals) !== value) {
    issues.push({ path, message: `must have no more than ${decimals} decimal places` });
  }
}

function markdownSource(
  value: unknown,
  id: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || !MARKDOWN_SOURCE_PATTERN.test(value)) {
    issues.push({ path, message: "must be a relative markdown/<object-id>.md path" });
  } else if (typeof id === "string" && value !== `markdown/${id}.md`) {
    issues.push({ path, message: "must use the canvas object's stable ID as its filename" });
  }
}

function imageAsset(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !IMAGE_ASSET_PATTERN.test(value)) {
    issues.push({ path, message: "must be a page-local content-addressed raster asset path" });
  }
}

function roundCanonicalNumber(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON cannot contain non-finite numbers");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new TypeError("Canonical JSON can contain only JSON values");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
