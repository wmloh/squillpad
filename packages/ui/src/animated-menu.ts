export const ANIMATED_MENU_OPEN = "floating-menu-open";
export const ANIMATED_MENU_CLOSE = "floating-menu-close";
export type AnimatedMenuPhase = "opening" | "closing";

interface AnimatedMenuParts {
  readonly menu: HTMLElement;
  readonly summary: HTMLElement;
}

interface AnimatedMenuSummaryEvent {
  preventDefault(): void;
}

function findAnimatedMenuParts(details: HTMLDetailsElement): AnimatedMenuParts | undefined {
  const summary = details.firstElementChild;
  if (!(summary instanceof HTMLElement) || summary.tagName !== "SUMMARY") return undefined;
  const menu = [...details.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.animatedMenu !== undefined,
  );
  return menu === undefined ? undefined : { menu, summary };
}

function updateAnimatedMenuOrigin(parts: AnimatedMenuParts): void {
  const { menu, summary } = parts;
  const previousAnimation = menu.style.animation;
  const previousTransform = menu.style.transform;
  menu.style.animation = "none";
  menu.style.transform = "none";
  const menuRect = menu.getBoundingClientRect();
  const summaryRect = summary.getBoundingClientRect();
  menu.style.animation = previousAnimation;
  menu.style.transform = previousTransform;

  if (menuRect.width > 0 && menuRect.height > 0) {
    menu.style.setProperty(
      "--menu-origin-x",
      `${summaryRect.left + summaryRect.width / 2 - (menuRect.left + menuRect.width / 2)}px`,
    );
    menu.style.setProperty(
      "--menu-origin-y",
      `${summaryRect.top + summaryRect.height / 2 - (menuRect.top + menuRect.height / 2)}px`,
    );
    menu.style.setProperty("--menu-origin-scale-x", String(summaryRect.width / menuRect.width));
    menu.style.setProperty("--menu-origin-scale-y", String(summaryRect.height / menuRect.height));
  }
}

export function refreshAnimatedMenuOrigin(details: HTMLDetailsElement): void {
  const parts = findAnimatedMenuParts(details);
  if (parts !== undefined) updateAnimatedMenuOrigin(parts);
}

export function prepareAnimatedMenu(details: HTMLDetailsElement, phase?: AnimatedMenuPhase): void {
  const parts = findAnimatedMenuParts(details);
  if (parts === undefined) return;

  const nextPhase = phase ?? (details.open ? "opening" : undefined);
  if (nextPhase === undefined) {
    delete details.dataset.menuPhase;
    return;
  }
  if (details.dataset.menuPhase === nextPhase) {
    if (nextPhase === "opening" && details.open) updateAnimatedMenuOrigin(parts);
    return;
  }
  if (nextPhase === "opening" && !details.open) {
    details.dataset.menuPhase = nextPhase;
    return;
  }

  updateAnimatedMenuOrigin(parts);
  details.dataset.menuPhase = nextPhase;
}

export function prepareAnimatedMenuFromSummary(
  summary: HTMLElement,
  event?: AnimatedMenuSummaryEvent,
): void {
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement)) return;
  if (!details.open) {
    prepareAnimatedMenu(details, "opening");
    return;
  }
  if (event === undefined) {
    prepareAnimatedMenu(details, "closing");
    return;
  }
  event.preventDefault();
  if (details.dataset.menuPhase === "closing") prepareAnimatedMenu(details, "opening");
  else closeAnimatedMenu(details);
}

export function closeAnimatedMenu(details: HTMLDetailsElement): void {
  if (!details.open) return;
  prepareAnimatedMenu(details, "closing");
}

/**
 * All animated dropdowns dismiss when pointer or focus interaction moves outside
 * the open menu. App-owned menus use the app-level capture handler; reusable
 * components must apply this same contract locally.
 */
export function dismissAnimatedMenuFromInteraction(
  details: HTMLDetailsElement | null,
  target?: EventTarget | null,
): void {
  if (details === null || !details.open) return;
  if (target instanceof Node && details.contains(target)) return;
  closeAnimatedMenu(details);
}

export function finishAnimatedMenu(
  details: HTMLDetailsElement,
  animationName: string,
  target: EventTarget | null,
): void {
  const parts = findAnimatedMenuParts(details);
  if (parts === undefined || target !== parts.menu) return;
  if (animationName === ANIMATED_MENU_OPEN && details.open) {
    details.dataset.menuPhase = "open";
  } else if (animationName === ANIMATED_MENU_CLOSE && details.dataset.menuPhase === "closing") {
    details.open = false;
    delete details.dataset.menuPhase;
  }
}
