import {
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  validateCanvasRecords,
  type CanvasRecord,
} from "@squillpad/core-model";

export type RepositoryMergeConflictKind = "canonical-file" | "canonical-field" | "canvas-record";

export interface RepositoryMergeConflict {
  readonly kind: RepositoryMergeConflictKind;
  readonly path: string;
  readonly message: string;
  readonly editable: boolean;
}

export interface CanonicalMergeResult {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly conflicts: readonly RepositoryMergeConflict[];
}

const MISSING = Symbol("missing canonical value");

/** Merges canonical files with a conservative three-way semantic policy. */
export function mergeCanonicalFiles(
  base: ReadonlyMap<string, Buffer>,
  local: ReadonlyMap<string, Buffer>,
  remote: ReadonlyMap<string, Buffer>,
): CanonicalMergeResult {
  const conflicts: RepositoryMergeConflict[] = [];
  const files = new Map<string, Buffer>();
  const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);

  for (const path of [...paths].sort()) {
    const merged = mergeFile(path, base.get(path), local.get(path), remote.get(path), conflicts);
    if (merged !== undefined) files.set(path, merged);
  }
  return { files, conflicts };
}

/**
 * Combines an unrelated local project on top of the fetched GitHub project.
 *
 * There is no common ancestor in this mode, so GitHub supplies the identity,
 * hierarchy metadata, and existing ordering. Local-only hierarchy entries are
 * appended, while same-ID canvas records and Markdown sources remain explicit
 * conflicts instead of being silently overwritten.
 */
export function mergeCanonicalFilesWithGitHubBase(
  local: ReadonlyMap<string, Buffer>,
  remote: ReadonlyMap<string, Buffer>,
): CanonicalMergeResult {
  const conflicts: RepositoryMergeConflict[] = [];
  const files = new Map<string, Buffer>();
  const paths = new Set([...local.keys(), ...remote.keys()]);

  for (const path of [...paths].sort()) {
    const merged = mergeGitHubBaseFile(path, local.get(path), remote.get(path), conflicts);
    if (merged !== undefined) files.set(path, merged);
  }
  return { files, conflicts };
}

function mergeFile(
  path: string,
  base: Buffer | undefined,
  local: Buffer | undefined,
  remote: Buffer | undefined,
  conflicts: RepositoryMergeConflict[],
): Buffer | undefined {
  if (
    path.endsWith("/canvas.jsonl") &&
    base !== undefined &&
    local !== undefined &&
    remote !== undefined
  ) {
    return mergeCanvas(path, base, local, remote, conflicts);
  }
  if (path.endsWith(".json") && base !== undefined && local !== undefined && remote !== undefined) {
    return mergeJsonFile(path, base, local, remote, conflicts);
  }
  return mergeBytes(path, base, local, remote, conflicts);
}

function mergeBytes(
  path: string,
  base: Buffer | undefined,
  local: Buffer | undefined,
  remote: Buffer | undefined,
  conflicts: RepositoryMergeConflict[],
): Buffer | undefined {
  if (sameBytes(local, remote)) return cloneBytes(local);
  if (sameBytes(local, base)) return cloneBytes(remote);
  if (sameBytes(remote, base)) return cloneBytes(local);
  conflicts.push({
    kind: "canonical-file",
    path,
    message: `Both snapshots changed ${path}.`,
    editable: path.endsWith(".md") && local !== undefined && remote !== undefined,
  });
  return cloneBytes(local);
}

function mergeJsonFile(
  path: string,
  base: Buffer,
  local: Buffer,
  remote: Buffer,
  conflicts: RepositoryMergeConflict[],
): Buffer {
  const baseValue = JSON.parse(base.toString("utf8")) as unknown;
  const localValue = JSON.parse(local.toString("utf8")) as unknown;
  const remoteValue = JSON.parse(remote.toString("utf8")) as unknown;
  const merged = mergeJsonValue(baseValue, localValue, remoteValue, path, conflicts);
  return Buffer.from(serializeCanonicalJson(merged), "utf8");
}

function mergeCanvas(
  path: string,
  base: Buffer,
  local: Buffer,
  remote: Buffer,
  conflicts: RepositoryMergeConflict[],
): Buffer {
  const baseRecords = canvasRecords(base, path);
  const localRecords = canvasRecords(local, path);
  const remoteRecords = canvasRecords(remote, path);
  const ids = new Set([...baseRecords.keys(), ...localRecords.keys(), ...remoteRecords.keys()]);
  const records: CanvasRecord[] = [];

  for (const id of [...ids].sort()) {
    const merged = mergeCanvasRecord(
      baseRecords.get(id),
      localRecords.get(id),
      remoteRecords.get(id),
      `${path}#${id}`,
      conflicts,
    );
    if (merged !== MISSING) records.push(merged as CanvasRecord);
  }
  return Buffer.from(serializeCanvasJsonLines(records), "utf8");
}

function mergeCanvasRecord(
  base: CanvasRecord | undefined,
  local: CanvasRecord | undefined,
  remote: CanvasRecord | undefined,
  path: string,
  conflicts: RepositoryMergeConflict[],
): unknown {
  const baseValue = base === undefined ? MISSING : base;
  const localValue = local === undefined ? MISSING : local;
  const remoteValue = remote === undefined ? MISSING : remote;
  if (sameJson(localValue, remoteValue)) return cloneJson(localValue);
  if (sameJson(localValue, baseValue)) return cloneJson(remoteValue);
  if (sameJson(remoteValue, baseValue)) return cloneJson(localValue);

  conflicts.push({
    kind: "canvas-record",
    path,
    message: `Both snapshots changed canvas element ${path}.`,
    editable: true,
  });
  return cloneJson(localValue);
}

function mergeGitHubBaseFile(
  path: string,
  local: Buffer | undefined,
  remote: Buffer | undefined,
  conflicts: RepositoryMergeConflict[],
): Buffer | undefined {
  if (local === undefined) return cloneBytes(remote);
  if (remote === undefined) return cloneBytes(local);
  if (sameBytes(local, remote)) return cloneBytes(remote);

  if (path.endsWith("/canvas.jsonl")) {
    return mergeGitHubBaseCanvas(path, local, remote, conflicts);
  }
  if (path === "notebook.json") {
    return mergeGitHubBaseNotebook(local, remote);
  }
  if (path.endsWith("/section.json")) {
    return mergeGitHubBaseSection(local, remote);
  }
  if (path.startsWith("profiles/") && path.endsWith(".json")) {
    conflicts.push({
      kind: "canonical-file",
      path,
      message: `Both snapshots changed profile settings ${path}.`,
      editable: false,
    });
  }
  if (path.endsWith(".md")) {
    conflicts.push({
      kind: "canonical-file",
      path,
      message: `Both snapshots changed ${path}.`,
      editable: true,
    });
  }
  return cloneBytes(remote);
}

function mergeGitHubBaseCanvas(
  path: string,
  local: Buffer,
  remote: Buffer,
  conflicts: RepositoryMergeConflict[],
): Buffer {
  const localRecords = canvasRecords(local, path);
  const remoteRecords = canvasRecords(remote, path);
  const ids = new Set([...localRecords.keys(), ...remoteRecords.keys()]);
  const records: CanvasRecord[] = [];

  for (const id of [...ids].sort()) {
    const localRecord = localRecords.get(id);
    const remoteRecord = remoteRecords.get(id);
    if (localRecord === undefined) {
      records.push(remoteRecord!);
    } else if (remoteRecord === undefined) {
      records.push(localRecord);
    } else if (sameJson(localRecord, remoteRecord)) {
      records.push(localRecord);
    } else {
      conflicts.push({
        kind: "canvas-record",
        path: `${path}#${id}`,
        message: `Both snapshots changed canvas element ${path}#${id}.`,
        editable: true,
      });
      records.push(remoteRecord);
    }
  }
  return Buffer.from(serializeCanvasJsonLines(records), "utf8");
}

function mergeGitHubBaseNotebook(local: Buffer, remote: Buffer): Buffer {
  const localValue = JSON.parse(local.toString("utf8")) as Record<string, unknown>;
  const remoteValue = JSON.parse(remote.toString("utf8")) as Record<string, unknown>;
  return Buffer.from(
    serializeCanonicalJson({
      ...remoteValue,
      sectionIds: appendIds(remoteValue.sectionIds, localValue.sectionIds),
    }),
    "utf8",
  );
}

function mergeGitHubBaseSection(local: Buffer, remote: Buffer): Buffer {
  const localValue = JSON.parse(local.toString("utf8")) as Record<string, unknown>;
  const remoteValue = JSON.parse(remote.toString("utf8")) as Record<string, unknown>;
  return Buffer.from(
    serializeCanonicalJson({
      ...remoteValue,
      metadata: mergeSectionMetadata(localValue.metadata, remoteValue.metadata),
      pageIds: appendIds(remoteValue.pageIds, localValue.pageIds),
    }),
    "utf8",
  );
}

function mergeSectionMetadata(local: unknown, remote: unknown): Record<string, unknown> {
  return {
    ...(isJsonObject(local) ? local : {}),
    ...(isJsonObject(remote) ? remote : {}),
  };
}

function appendIds(remote: unknown, local: unknown): readonly unknown[] {
  const result = Array.isArray(remote) ? [...remote] : [];
  if (!Array.isArray(local)) return result;
  const seen = new Set(result);
  for (const value of local) {
    if (typeof value === "string" && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function canvasRecords(source: Buffer, path: string): Map<string, CanvasRecord> {
  const text = source.toString("utf8");
  const lines =
    text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  const result = validateCanvasRecords(parsed);
  if (!result.success) throw new Error(`Cannot merge invalid canvas file ${path}`);
  return new Map(result.data.map((record) => [record.id, record]));
}

function mergeJsonValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: string,
  conflicts: RepositoryMergeConflict[],
): unknown {
  const baseValue = base === undefined ? MISSING : base;
  const localValue = local === undefined ? MISSING : local;
  const remoteValue = remote === undefined ? MISSING : remote;
  if (sameJson(localValue, remoteValue)) return cloneJson(localValue);
  if (sameJson(localValue, baseValue)) return cloneJson(remoteValue);
  if (sameJson(remoteValue, baseValue)) return cloneJson(localValue);

  if (isJsonObject(baseValue) && isJsonObject(localValue) && isJsonObject(remoteValue)) {
    const keys = new Set([
      ...Object.keys(baseValue),
      ...Object.keys(localValue),
      ...Object.keys(remoteValue),
    ]);
    const merged: Record<string, unknown> = {};
    for (const key of [...keys].sort()) {
      const value = mergeJsonValue(
        baseValue[key],
        localValue[key],
        remoteValue[key],
        `${path}.${key}`,
        conflicts,
      );
      if (value !== MISSING) merged[key] = value;
    }
    return merged;
  }

  conflicts.push({
    kind: path.includes("/canvas.jsonl#") ? "canvas-record" : "canonical-field",
    path,
    message: `Both snapshots changed ${path}.`,
    editable: path.includes("/canvas.jsonl#") || path.endsWith(".md"),
  });
  return cloneJson(localValue);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function cloneBytes(value: Buffer | undefined): Buffer | undefined {
  return value === undefined ? undefined : Buffer.from(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function cloneJson(value: unknown): unknown {
  if (value === MISSING) return MISSING;
  return value === undefined ? MISSING : (JSON.parse(JSON.stringify(value)) as unknown);
}
