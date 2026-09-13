import {
  canonicalCoordinate,
  type CanvasRecord,
  type ImageCanvasRecord,
  type MarkdownCanvasRecord,
  type ShapeCanvasRecord,
} from "./canonical-format.js";

/** A heterogeneous object that participates in the shared page canvas model. */
export type CanvasElement = CanvasRecord;

/** An axis-aligned rectangle in world coordinates. */
export interface CanvasBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A world-coordinate displacement. */
export interface CanvasDelta {
  readonly x: number;
  readonly y: number;
}

/** A pluggable policy used by canvas tools to evaluate one element. */
export interface CanvasHitTestPolicy {
  readonly hit: (element: CanvasElement, point: CanvasDelta, bounds: CanvasBounds) => boolean;
}

const elementBoundsCache = new WeakMap<object, CanvasBounds>();

/** Result of duplication, including the new transient selection. */
export interface DuplicateElementsResult {
  readonly elements: readonly CanvasElement[];
  readonly duplicatedIds: ReadonlySet<string>;
}

/** Padding between grouped Markdown blocks and their visual frame. */
export const TEXT_BOX_GROUP_PADDING = 12;

/** Returns the Markdown blocks that define one text-box group. */
export function textBoxGroupBlocks(
  elements: readonly CanvasElement[],
  textGroupId: string,
): readonly MarkdownCanvasRecord[] {
  return elements
    .filter(
      (element): element is MarkdownCanvasRecord =>
        element.kind === "markdown" && element.textGroupId === textGroupId,
    )
    .sort((left, right) => left.position[1] - right.position[1] || compareIds(left.id, right.id));
}

/** Returns the padded frame defined by the text boxes in a group. */
export function textBoxGroupBounds(
  elements: readonly CanvasElement[],
  textGroupId: string,
  padding = TEXT_BOX_GROUP_PADDING,
): CanvasBounds | undefined {
  const blocks = textBoxGroupBlocks(elements, textGroupId);
  if (blocks.length === 0) return undefined;
  const minX = Math.min(...blocks.map((block) => block.position[0]));
  const minY = Math.min(...blocks.map((block) => block.position[1]));
  const maxX = Math.max(...blocks.map((block) => block.position[0] + block.width));
  const maxY = Math.max(...blocks.map((block) => block.position[1] + block.height));
  return {
    x: canonicalCoordinate(minX - padding),
    y: canonicalCoordinate(minY - padding),
    width: canonicalCoordinate(maxX - minX + padding * 2),
    height: canonicalCoordinate(maxY - minY + padding * 2),
  };
}

/** Returns explicit text members and non-text elements centered within a group's frame. */
export function textBoxGroupMemberIds(
  elements: readonly CanvasElement[],
  textGroupId: string,
): ReadonlySet<string> {
  const bounds = textBoxGroupBounds(elements, textGroupId);
  if (bounds === undefined) return new Set();
  return new Set(
    elements
      .filter((element) => {
        if (element.kind === "markdown") return element.textGroupId === textGroupId;
        const candidate = elementBounds(element);
        return boundsContainPoint(bounds, {
          x: candidate.x + candidate.width / 2,
          y: candidate.y + candidate.height / 2,
        });
      })
      .map((element) => element.id),
  );
}

/** Assigns one Markdown block to a newly created or existing text-box group. */
export function assignTextBoxGroup(
  elements: readonly CanvasElement[],
  markdownId: string,
  textGroupId: string,
): readonly CanvasElement[] {
  return elements.map((element) =>
    element.id === markdownId && element.kind === "markdown"
      ? { ...element, textGroupId }
      : element,
  );
}

/** Applies a Markdown color style to one box or every box in its text-box group. */
export function setMarkdownColorStyle(
  elements: readonly CanvasElement[],
  markdownId: string,
  markdownStyleId: string | undefined,
): readonly CanvasElement[] {
  const target = elements.find((element) => element.id === markdownId);
  if (target?.kind !== "markdown") return elements;
  return elements.map((element) => {
    if (
      element.kind !== "markdown" ||
      (target.textGroupId === undefined
        ? element.id !== markdownId
        : element.textGroupId !== target.textGroupId)
    ) {
      return element;
    }
    if (markdownStyleId === undefined) {
      const { markdownStyleId: _removed, ...original } = element;
      return original;
    }
    return { ...element, markdownStyleId };
  });
}

/** Returns deterministic world-space bounds for every canonical element kind. */
export function elementBounds(element: CanvasElement): CanvasBounds {
  const cached = elementBoundsCache.get(element);
  if (cached !== undefined) return cached;

  const bounds = calculateElementBounds(element);
  elementBoundsCache.set(element, bounds);
  return bounds;
}

function calculateElementBounds(element: CanvasElement): CanvasBounds {
  if (element.kind === "markdown" || element.kind === "image") {
    return {
      x: element.position[0],
      y: element.position[1],
      width: element.width,
      height: element.height,
    };
  }
  if (element.kind === "ink") {
    return pointBounds(element.position, element.points, element.style.width / 2);
  }
  if (element.geometry.kind === "rectangle" || element.geometry.kind === "ellipse") {
    return {
      x: element.position[0],
      y: element.position[1],
      width: element.geometry.width,
      height: element.geometry.height,
    };
  }
  return pointBounds(
    element.position,
    [element.geometry.start, element.geometry.end],
    element.style.strokeWidth / 2,
  );
}

function pointBounds(
  position: readonly [number, number],
  points: readonly (readonly [number, number])[],
  padding: number,
): CanvasBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0] + position[0] - padding);
    minY = Math.min(minY, point[1] + position[1] - padding);
    maxX = Math.max(maxX, point[0] + position[0] + padding);
    maxY = Math.max(maxY, point[1] + position[1] + padding);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Returns elements in deterministic back-to-front stacking order. */
export function elementsByZ(elements: readonly CanvasElement[]): readonly CanvasElement[] {
  return [...elements].sort((left, right) => left.z - right.z || compareIds(left.id, right.id));
}

/** Inserts an element at the front through the common immutable model API. */
export function insertElement(
  elements: readonly CanvasElement[],
  element: CanvasElement,
): readonly CanvasElement[] {
  if (elements.some((candidate) => candidate.id === element.id)) {
    throw new Error(`Canvas element ID already exists: ${element.id}`);
  }
  const z = elements.reduce((maximum, candidate) => Math.max(maximum, candidate.z), -1) + 1;
  return normalizeZ([...elementsByZ(elements), { ...element, z }]);
}

/** Deletes elements by stable ID through the common immutable model API. */
export function deleteElements(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  return normalizeZ(elementsByZ(elements).filter((element) => !ids.has(element.id)));
}

/** Moves all selected elements by one world-coordinate displacement. */
export function moveElements(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  delta: CanvasDelta,
): readonly CanvasElement[] {
  const movedIds = expandGroupedSelection(elements, ids);
  return elements.map((element) =>
    movedIds.has(element.id)
      ? {
          ...element,
          position: [
            canonicalCoordinate(element.position[0] + delta.x),
            canonicalCoordinate(element.position[1] + delta.y),
          ],
        }
      : element,
  );
}

/** Expands a selection to include every member of each selected group. */
export function expandGroupedSelection(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  const groupIds = new Set(
    elements
      .filter((element) => ids.has(element.id) && element.groupId !== undefined)
      .map((element) => element.groupId),
  );
  return new Set(
    elements
      .filter(
        (element) =>
          ids.has(element.id) || (element.groupId !== undefined && groupIds.has(element.groupId)),
      )
      .map((element) => element.id),
  );
}

/** Assigns a stable group identifier to every selected group member. */
export function groupElements(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  groupId: string,
): readonly CanvasElement[] {
  const groupedIds = expandGroupedSelection(elements, ids);
  return elements.map((element) =>
    groupedIds.has(element.id) ? { ...element, groupId } : element,
  );
}

/** Removes group membership from every selected group member. */
export function ungroupElements(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  const groupedIds = expandGroupedSelection(elements, ids);
  return elements.map((element) => {
    if (!groupedIds.has(element.id) || element.groupId === undefined) return element;
    const { groupId: _groupId, ...ungrouped } = element;
    return ungrouped;
  });
}

/** Reports whether an element supports rectangular resize handles. */
export function isResizableElement(
  element: CanvasElement,
): element is ImageCanvasRecord | MarkdownCanvasRecord | ShapeCanvasRecord {
  return element.kind === "image" || element.kind === "markdown" || element.kind === "shape";
}

/** Resizes one supported element to an absolute world-space rectangle. */
export function resizeElement(
  elements: readonly CanvasElement[],
  id: string,
  bounds: CanvasBounds,
  minimumSize = 24,
): readonly CanvasElement[] {
  const target = elements.find((element) => element.id === id);
  if (target?.kind === "markdown" && target.textGroupId !== undefined) {
    return resizeTextBoxGroupBlock(elements, target, bounds, minimumSize);
  }
  return elements.map((element) => {
    if (element.id !== id || !isResizableElement(element)) return element;
    const position = [canonicalCoordinate(bounds.x), canonicalCoordinate(bounds.y)] as const;
    const minimumHeight = element.kind === "markdown" ? Math.max(72, minimumSize) : minimumSize;
    const width = canonicalCoordinate(Math.max(minimumSize, bounds.width));
    const height = canonicalCoordinate(Math.max(minimumHeight, bounds.height));
    if (element.kind === "markdown" || element.kind === "image") {
      return { ...element, position, width, height };
    }
    if (element.geometry.kind === "rectangle" || element.geometry.kind === "ellipse") {
      return { ...element, position, geometry: { ...element.geometry, width, height } };
    }
    const current = elementBounds(element);
    const scaleX = width / Math.max(current.width, 0.001);
    const scaleY = height / Math.max(current.height, 0.001);
    const resizePoint = (point: readonly [number, number]) =>
      [
        canonicalCoordinate((element.position[0] + point[0] - current.x) * scaleX),
        canonicalCoordinate((element.position[1] + point[1] - current.y) * scaleY),
      ] as const;
    return {
      ...element,
      position,
      geometry: {
        ...element.geometry,
        start: resizePoint(element.geometry.start),
        end: resizePoint(element.geometry.end),
      },
    };
  });
}

function resizeTextBoxGroupBlock(
  elements: readonly CanvasElement[],
  target: MarkdownCanvasRecord,
  bounds: CanvasBounds,
  minimumSize: number,
): readonly CanvasElement[] {
  const memberIds = textBoxGroupMemberIds(elements, target.textGroupId as string);
  const minimumHeight = Math.max(72, minimumSize);
  const nextBounds = {
    x: canonicalCoordinate(bounds.x),
    y: canonicalCoordinate(bounds.y),
    width: canonicalCoordinate(Math.max(minimumSize, bounds.width)),
    height: canonicalCoordinate(Math.max(minimumHeight, bounds.height)),
  };
  const oldBottom = target.position[1] + target.height;
  const bottomDelta = canonicalCoordinate(nextBounds.y + nextBounds.height - oldBottom);
  return elements.map((element) => {
    if (element.kind === "markdown" && element.textGroupId === target.textGroupId) {
      if (element.id === target.id) {
        return {
          ...element,
          position: [nextBounds.x, nextBounds.y],
          width: nextBounds.width,
          height: nextBounds.height,
        };
      }
      const shift = element.position[1] >= oldBottom ? bottomDelta : 0;
      return {
        ...element,
        position: [nextBounds.x, canonicalCoordinate(element.position[1] + shift)],
        width: nextBounds.width,
      };
    }
    if (!memberIds.has(element.id)) return element;
    const candidate = elementBounds(element);
    if (candidate.y + candidate.height / 2 < oldBottom) return element;
    return {
      ...element,
      position: [
        element.position[0],
        canonicalCoordinate(element.position[1] + bottomDelta),
      ] as const,
    };
  });
}

/** Moves one grouped text box vertically without overlapping its preceding text box. */
export function moveTextBoxGroupBlock(
  elements: readonly CanvasElement[],
  markdownId: string,
  deltaY: number,
): readonly CanvasElement[] {
  const target = elements.find(
    (element): element is MarkdownCanvasRecord =>
      element.id === markdownId && element.kind === "markdown",
  );
  if (target?.textGroupId === undefined || deltaY === 0 || !Number.isFinite(deltaY)) {
    return elements;
  }
  const blocks = textBoxGroupBlocks(elements, target.textGroupId);
  const targetIndex = blocks.findIndex((block) => block.id === target.id);
  const previous = blocks[targetIndex - 1];
  const minimumDeltaY =
    previous === undefined
      ? -Infinity
      : previous.position[1] + previous.height - target.position[1];
  const constrainedDeltaY = Math.max(deltaY, minimumDeltaY);
  if (constrainedDeltaY === 0) return elements;
  const memberIds = textBoxGroupMemberIds(elements, target.textGroupId);
  const cutY = target.position[1] + target.height;
  return elements.map((element) => {
    const isTarget = element.id === target.id;
    const isLaterText =
      element.kind === "markdown" &&
      element.textGroupId === target.textGroupId &&
      element.position[1] > target.position[1];
    const candidate = elementBounds(element);
    const isContentBelow =
      element.kind !== "markdown" &&
      memberIds.has(element.id) &&
      candidate.y + candidate.height / 2 >= cutY;
    if (!isTarget && !isLaterText && !isContentBelow) return element;
    return {
      ...element,
      position: [
        element.position[0],
        canonicalCoordinate(element.position[1] + constrainedDeltaY),
      ] as const,
    };
  });
}

/** Inserts a Markdown block below one group member and opens matching local space. */
export function insertTextBoxGroupBlock(
  elements: readonly CanvasElement[],
  afterId: string,
  block: MarkdownCanvasRecord,
  gap = 48,
): readonly CanvasElement[] {
  const after = elements.find(
    (element): element is MarkdownCanvasRecord =>
      element.id === afterId && element.kind === "markdown",
  );
  if (after?.textGroupId === undefined) return elements;
  const memberIds = textBoxGroupMemberIds(elements, after.textGroupId);
  const shift = block.height + gap;
  const cutY = after.position[1] + after.height;
  const opened: readonly CanvasElement[] = elements.map((element) => {
    const candidate = elementBounds(element);
    const isLaterText =
      element.kind === "markdown" &&
      element.textGroupId === after.textGroupId &&
      element.position[1] > after.position[1];
    const isContentBelow =
      element.kind !== "markdown" &&
      memberIds.has(element.id) &&
      candidate.y + candidate.height / 2 >= cutY;
    if (!isLaterText && !isContentBelow) return element;
    return {
      ...element,
      position: [element.position[0], canonicalCoordinate(element.position[1] + shift)] as const,
    };
  });
  return insertElement(opened, {
    ...block,
    textGroupId: after.textGroupId,
    position: [after.position[0], canonicalCoordinate(cutY + gap)] as const,
    width: after.width,
  });
}

/** Returns the top edge where a Markdown block would be inserted in a text-box group. */
export function textBoxGroupInsertionY(
  elements: readonly CanvasElement[],
  textGroupId: string,
  dropY: number,
  gap = 48,
): number | undefined {
  if (!Number.isFinite(dropY) || !Number.isFinite(gap) || gap < 0) return undefined;
  const blocks = textBoxGroupBlocks(elements, textGroupId);
  if (blocks.length === 0) return undefined;
  const insertionIndex = blocks.findIndex((block) => dropY < block.position[1] + block.height / 2);
  const boundedInsertionIndex = insertionIndex < 0 ? blocks.length : insertionIndex;
  const previous = blocks[boundedInsertionIndex - 1];
  const first = blocks[0];
  if (first === undefined) return undefined;
  return previous === undefined ? first.position[1] : previous.position[1] + previous.height + gap;
}

/** Attaches one ungrouped Markdown block to a text-box group and opens local space. */
export function attachTextBoxGroupBlock(
  elements: readonly CanvasElement[],
  markdownId: string,
  textGroupId: string,
  dropY: number,
  gap = 48,
): readonly CanvasElement[] {
  const target = elements.find(
    (element): element is MarkdownCanvasRecord =>
      element.id === markdownId && element.kind === "markdown",
  );
  const blocks = textBoxGroupBlocks(elements, textGroupId);
  if (
    target === undefined ||
    target.textGroupId !== undefined ||
    target.groupId !== undefined ||
    blocks.length === 0 ||
    !Number.isFinite(dropY) ||
    !Number.isFinite(gap) ||
    gap < 0
  ) {
    return elements;
  }

  const memberIds = textBoxGroupMemberIds(elements, textGroupId);
  const insertionIndex = blocks.findIndex((block) => dropY < block.position[1] + block.height / 2);
  const boundedInsertionIndex = insertionIndex < 0 ? blocks.length : insertionIndex;
  const insertionY = textBoxGroupInsertionY(elements, textGroupId, dropY, gap);
  if (insertionY === undefined) return elements;
  const contentX = Math.min(...blocks.map((block) => block.position[0]));
  const contentWidth = Math.max(...blocks.map((block) => block.width));
  const groupMarkdownStyleId = blocks[0]?.markdownStyleId;
  const shiftedTextIds = new Set(blocks.slice(boundedInsertionIndex).map((block) => block.id));
  const shift = target.height + gap;

  return elements.map((element) => {
    if (element.id === target.id && element.kind === "markdown") {
      const { markdownStyleId: _previousStyleId, ...unstyled } = element;
      return {
        ...unstyled,
        textGroupId,
        position: [canonicalCoordinate(contentX), canonicalCoordinate(insertionY)] as const,
        width: canonicalCoordinate(contentWidth),
        ...(groupMarkdownStyleId === undefined ? {} : { markdownStyleId: groupMarkdownStyleId }),
      };
    }
    const isLaterText = shiftedTextIds.has(element.id);
    const candidate = elementBounds(element);
    const isContentBelow =
      element.kind !== "markdown" &&
      memberIds.has(element.id) &&
      candidate.y + candidate.height / 2 >= insertionY;
    if (!isLaterText && !isContentBelow) return element;
    return {
      ...element,
      position: [element.position[0], canonicalCoordinate(element.position[1] + shift)] as const,
    };
  });
}

/** Detaches one text box, moves it right, and closes its former vertical space. */
export function detachTextBoxGroupBlock(
  elements: readonly CanvasElement[],
  markdownId: string,
  gap = 48,
): readonly CanvasElement[] {
  const target = elements.find(
    (element): element is MarkdownCanvasRecord =>
      element.id === markdownId && element.kind === "markdown",
  );
  if (target?.textGroupId === undefined) return elements;
  const frame = textBoxGroupBounds(elements, target.textGroupId);
  if (frame === undefined) return elements;
  const memberIds = textBoxGroupMemberIds(elements, target.textGroupId);
  const shift = target.height + gap;
  const cutY = target.position[1] + target.height;
  return elements.map((element) => {
    if (element.id === target.id && element.kind === "markdown") {
      const detached = { ...element };
      delete detached.textGroupId;
      return {
        ...detached,
        position: [canonicalCoordinate(frame.x + frame.width + gap), element.position[1]] as const,
      };
    }
    const candidate = elementBounds(element);
    const isLaterText =
      element.kind === "markdown" &&
      element.textGroupId === target.textGroupId &&
      element.position[1] > target.position[1];
    const isContentBelow =
      element.kind !== "markdown" &&
      memberIds.has(element.id) &&
      candidate.y + candidate.height / 2 >= cutY;
    if (!isLaterText && !isContentBelow) return element;
    return {
      ...element,
      position: [element.position[0], canonicalCoordinate(element.position[1] - shift)] as const,
    };
  });
}

/** Moves selected elements one layer toward the front. */
export function bringForward(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  const ordered = [...elementsByZ(elements)];
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (current !== undefined && next !== undefined && ids.has(current.id) && !ids.has(next.id)) {
      ordered[index] = next;
      ordered[index + 1] = current;
    }
  }
  return normalizeZ(ordered);
}

/** Moves selected elements one layer toward the back. */
export function sendBackward(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  const ordered = [...elementsByZ(elements)];
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index];
    const previous = ordered[index - 1];
    if (
      current !== undefined &&
      previous !== undefined &&
      ids.has(current.id) &&
      !ids.has(previous.id)
    ) {
      ordered[index] = previous;
      ordered[index - 1] = current;
    }
  }
  return normalizeZ(ordered);
}

/** Moves selected elements above every unselected element. */
export function bringToFront(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  return partitionLayers(elements, ids, false);
}

/** Moves selected elements below every unselected element. */
export function sendToBack(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
): readonly CanvasElement[] {
  return partitionLayers(elements, ids, true);
}

/** Duplicates selected objects with stable new IDs and a visible world-space offset. */
export function duplicateElements(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  createId: () => string,
  offset: CanvasDelta = { x: 24, y: 24 },
  createGroupId: () => string = createId,
): DuplicateElementsResult {
  let result = [...elements];
  const duplicatedIds = new Set<string>();
  const duplicatedGroupIds = new Map<string, string>();
  const duplicatedTextGroupIds = new Map<string, string>();
  for (const element of elementsByZ(elements)) {
    if (!ids.has(element.id)) continue;
    const id = createId();
    if (result.some((candidate) => candidate.id === id)) {
      throw new Error(`Canvas element ID already exists: ${id}`);
    }
    const groupId =
      element.groupId === undefined
        ? undefined
        : (duplicatedGroupIds.get(element.groupId) ??
          (() => {
            const nextGroupId = createGroupId();
            duplicatedGroupIds.set(element.groupId, nextGroupId);
            return nextGroupId;
          })());
    const textGroupId =
      element.kind !== "markdown" || element.textGroupId === undefined
        ? undefined
        : (duplicatedTextGroupIds.get(element.textGroupId) ??
          (() => {
            const nextTextGroupId = createGroupId();
            duplicatedTextGroupIds.set(element.textGroupId, nextTextGroupId);
            return nextTextGroupId;
          })());
    const copy = duplicateWithId(element, id, offset, groupId, textGroupId);
    result = [...insertElement(result, copy)];
    duplicatedIds.add(id);
  }
  return { elements: result, duplicatedIds };
}

/** Finds hits from front to back using a tool-selected policy. */
export function hitTestElements(
  elements: readonly CanvasElement[],
  point: CanvasDelta,
  policy: CanvasHitTestPolicy = boundsHitTestPolicy,
): readonly CanvasElement[] {
  return [...elementsByZ(elements)].reverse().filter((element) => {
    const bounds = elementBounds(element);
    return boundsContainPoint(bounds, point) && policy.hit(element, point, bounds);
  });
}

/** General-purpose policy that accepts any point inside deterministic bounds. */
export const boundsHitTestPolicy: CanvasHitTestPolicy = {
  hit: (_element, point, bounds) => boundsContainPoint(bounds, point),
};

/** Returns whether an axis-aligned point lies inside or on a rectangle. */
export function boundsContainPoint(bounds: CanvasBounds, point: CanvasDelta): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/** Returns whether two axis-aligned rectangles overlap or touch. */
export function boundsOverlap(left: CanvasBounds, right: CanvasBounds): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

function duplicateWithId(
  element: CanvasElement,
  id: string,
  offset: CanvasDelta,
  groupId: string | undefined,
  textGroupId: string | undefined,
): CanvasElement {
  const position = [
    canonicalCoordinate(element.position[0] + offset.x),
    canonicalCoordinate(element.position[1] + offset.y),
  ] as const;
  const group = groupId === undefined ? {} : { groupId };
  if (element.kind === "markdown") {
    const textGroup = textGroupId === undefined ? {} : { textGroupId };
    return { ...element, ...group, ...textGroup, id, position, source: `markdown/${id}.md` };
  }
  return { ...element, ...group, id, position };
}

function partitionLayers(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  selectedFirst: boolean,
): readonly CanvasElement[] {
  const ordered = elementsByZ(elements);
  const selected = ordered.filter((element) => ids.has(element.id));
  const unselected = ordered.filter((element) => !ids.has(element.id));
  return normalizeZ(selectedFirst ? [...selected, ...unselected] : [...unselected, ...selected]);
}

function normalizeZ(elements: readonly CanvasElement[]): readonly CanvasElement[] {
  return elements.map((element, z) => (element.z === z ? element : { ...element, z }));
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
