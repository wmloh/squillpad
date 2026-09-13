import { expect, test, type Page } from "@playwright/test";

async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
async function saved(page: Page) {
  await page.waitForTimeout(600);
  await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
}

test("mixed content shares layers, gestures, history and canonical reopening", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/");
  const canvas = page.getByLabel("Infinite page canvas");
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 150, bounds.y + 130);
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await page.keyboard.insertText("# Mixed canvas\n\nInk belongs over this text.");
  await page.keyboard.press("Control+a");
  await expect(page.locator(".canvas-element.is-selected")).toHaveCount(1);
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(canvas).toBeFocused();
  const markdown = page.locator('[data-canvas-element-id].kind-markdown');
  const box = (await markdown.boundingBox())!;
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await drag(page, box.x + 40, box.y + 35, 180, 15);
  const ink = page.locator('[data-canvas-element-id].kind-ink');
  await expect(ink).toHaveCount(1);
  await expect(editor).toHaveCount(0);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(ink).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(ink).toHaveCount(1);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await ink.click();
  await page.getByTitle("Send to back", { exact: true }).click();
  expect(Number(await ink.evaluate((el) => (el as HTMLElement).style.zIndex))).toBeLessThan(
    Number(await markdown.evaluate((el) => (el as HTMLElement).style.zIndex)),
  );
  await expect(page.locator(".canvas-selection-overlay")).toHaveCount(1);
  await page.getByTitle("Bring to front", { exact: true }).click();
  const inkGeometry = await ink.getAttribute("style");
  await page.getByLabel("Move Markdown block").click();
  const handle = (await page.getByLabel("Resize markdown element", { exact: true }).boundingBox())!;
  await drag(page, handle.x + handle.width / 2, handle.y + handle.height / 2, 60, 0);
  expect(await ink.getAttribute("style")).toBe(inkGeometry);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  expect(await ink.getAttribute("style")).toBe(inkGeometry);
  await canvas.focus();
  await page.keyboard.press("Control+a");
  const before = await page
    .locator("[data-canvas-element-id]")
    .evaluateAll((items) =>
      items.map((item) => ({
        id: item.getAttribute("data-canvas-element-id"),
        left: (item as HTMLElement).style.left,
        top: (item as HTMLElement).style.top,
      })),
    );
  const ib = (await ink.boundingBox())!;
  await drag(page, ib.x + ib.width / 2, ib.y + ib.height / 2, 60, 50);
  const moved = await page
    .locator("[data-canvas-element-id]")
    .evaluateAll((items) =>
      items.map((item) => ({
        id: item.getAttribute("data-canvas-element-id"),
        left: (item as HTMLElement).style.left,
        top: (item as HTMLElement).style.top,
      })),
    );
  expect(moved).not.toEqual(before);
  await page.keyboard.press("Control+z");
  expect(
    await page
      .locator("[data-canvas-element-id]")
      .evaluateAll((items) =>
        items.map((item) => ({
          id: item.getAttribute("data-canvas-element-id"),
          left: (item as HTMLElement).style.left,
          top: (item as HTMLElement).style.top,
        })),
      ),
  ).toEqual(before);
  await page.keyboard.press("Control+Shift+z");
  await saved(page);
  const route = new URL(page.url()).hash.split("/");
  const api = `/api/pages/${route[4]}/${route[6]}`;
  const canonical = await (await page.request.get(api)).json();
  expect((await page.request.get("http://127.0.0.1:4273/e2e/reopen")).ok()).toBe(true);
  await page.reload();
  await expect(ink).toHaveCount(1);
  await expect(markdown).toContainText("Mixed canvas");
  expect(await (await page.request.get(api)).json()).toEqual(canonical);
  expect(
    await page
      .locator("[data-canvas-element-id]")
      .evaluateAll((items) =>
        items.map((item) => ({
          id: item.getAttribute("data-canvas-element-id"),
          left: (item as HTMLElement).style.left,
          top: (item as HTMLElement).style.top,
        })),
      ),
  ).toEqual(moved);
  expect(errors).toEqual([]);
});

async function newPage(page: Page) {
  const pages = page.locator(".page-list > li > .page-select");
  await expect(pages.first()).toBeVisible();
  const count = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(count + 1);
  await pages.last().click();
  await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
}

async function chooseRectangle(page: Page) {
  await page.getByText("Shapes", { exact: true }).click();
  await page.getByTitle("Rectangle tool", { exact: true }).click();
}

test("clipboard and page history preserve sources, IDs, and independent geometry", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  await newPage(page);
  const canvas = page.getByLabel("Infinite page canvas");
  await expect(canvas).toBeVisible();
  const b = (await canvas.boundingBox())!;
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(b.x + 120, b.y + 100);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.insertText("Clipboard source $x^2$");
  await page.keyboard.press("Escape");
  await chooseRectangle(page);
  await drag(page, b.x + 420, b.y + 100, 90, 75);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const objects = page.locator("[data-canvas-element-id]");
  await canvas.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(4);
  await expect(page.locator('[data-canvas-element-id].kind-markdown').last()).toContainText(
    "Clipboard source",
  );
  const ids = await objects.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-canvas-element-id")),
  );
  expect(new Set(ids).size).toBe(4);
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect(objects).toHaveCount(4);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+x");
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(objects).toHaveCount(4);
  await expect(page.locator('[data-canvas-element-id].kind-markdown').first()).toContainText(
    "Clipboard source",
  );
  await canvas.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  const originalRoute = new URL(page.url()).hash;
  await newPage(page);
  await expect(objects).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(4);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(objects).toHaveCount(0);
  await page.evaluate((hash) => {
    location.hash = hash;
  }, originalRoute);
  await expect(objects).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
  const shape = page.locator('[data-canvas-element-id].kind-shape').first();
  const shapePosition = await shape.getAttribute("style");
  await page.locator(".canvas-markdown-drag-handle").first().click();
  const resize = (await page.getByLabel("Resize markdown element", { exact: true }).boundingBox())!;
  const width = await page
    .locator('[data-canvas-element-id].kind-markdown')
    .first()
    .evaluate((el) => (el as HTMLElement).style.width);
  await drag(page, resize.x + resize.width / 2, resize.y + resize.height / 2, 80, 0);
  expect(await shape.getAttribute("style")).toBe(shapePosition);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  expect(
    await page
      .locator('[data-canvas-element-id].kind-markdown')
      .first()
      .evaluate((el) => (el as HTMLElement).style.width),
  ).toBe(width);
});

test("undoes and redoes custom palette and Markdown style edits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  await newPage(page);
  await page.getByRole("button", { name: "Pen", exact: true }).click();

  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const customPalette = page.getByLabel("Use custom pen colors", { exact: true });
  await expect(customPalette).toBeVisible();
  await expect(customPalette).not.toBeChecked();

  await customPalette.check();
  await expect(customPalette).toBeChecked();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(customPalette).not.toBeChecked();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(customPalette).toBeChecked();

  await page.getByRole("button", { name: "Use ink color #9ca3af", exact: true }).click();
  const paletteEditor = page.getByRole("dialog", {
    name: "pen custom palette editor",
    exact: true,
  });
  await expect(paletteEditor).toBeVisible();
  await paletteEditor
    .getByRole("button", { name: "Select palette color #dc2626", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Use ink color #dc2626", exact: true }),
  ).toBeVisible();
  await undo.click();
  await expect(
    page.getByRole("button", { name: "Use ink color #9ca3af", exact: true }),
  ).toBeVisible();
  await redo.click();
  await expect(page.getByRole("button", { name: "Use ink color #dc2626", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByText("Edit styles", { exact: true }).click();
  await page.getByRole("button", { name: "+ New style", exact: true }).click();
  const bodyLight = page.getByLabel("Body text Light mode color", { exact: true });
  await bodyLight.evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "#ff0000");
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(bodyLight).toHaveValue("#ff0000");
  await bodyLight.focus();
  await page.keyboard.press("Control+z");
  await expect(bodyLight).toHaveValue("#27252b");
  await page.keyboard.press("Control+Shift+z");
  await expect(bodyLight).toHaveValue("#ff0000");
});

test("pastes, copies, moves, and groups embedded clipboard images", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  await newPage(page);
  const canvas = page.getByLabel("Infinite page canvas");
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 180, bounds.y + 140);
  await page.evaluate(async () => {
    const source = document.createElement("canvas");
    source.width = 3;
    source.height = 2;
    const context = source.getContext("2d");
    if (context === null) throw new Error("Canvas context is unavailable");
    context.fillStyle = "#7052a5";
    context.fillRect(0, 0, source.width, source.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      source.toBlob(
        (value) => (value === null ? reject(new Error("PNG encoding failed")) : resolve(value)),
        "image/png",
      ),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "clipboard.png", { type: "image/png" }));
    document
      .querySelector<HTMLElement>(".spatial-canvas")
      ?.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
  });

  const images = page.locator("[data-canvas-element-id].kind-image");
  await expect(images).toHaveCount(1);
  await expect(images.first()).toHaveAttribute("aria-label", "image element");
  expect(await images.first().evaluate((element) => (element as HTMLElement).style.width)).toBe(
    "3px",
  );
  expect(await images.first().evaluate((element) => (element as HTMLElement).style.height)).toBe(
    "2px",
  );

  await canvas.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(images).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await page.getByLabel("Group selection", { exact: true }).click();
  await expect(page.getByLabel("Ungroup selection", { exact: true })).toBeVisible();

  const beforeMove = await images.evaluateAll((items) =>
    items.map((item) => ({ left: (item as HTMLElement).style.left, top: (item as HTMLElement).style.top })),
  );
  const imageBounds = (await images.first().boundingBox())!;
  await drag(
    page,
    imageBounds.x + imageBounds.width / 2,
    imageBounds.y + imageBounds.height / 2,
    40,
    24,
  );
  const afterMove = await images.evaluateAll((items) =>
    items.map((item) => ({ left: (item as HTMLElement).style.left, top: (item as HTMLElement).style.top })),
  );
  expect(afterMove).not.toEqual(beforeMove);
});

test("keeps shape controls grouped and shows all action controls in fullscreen", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const normalShapeSummary = page.locator(
    ".canvas-toolbar:not(.is-fullscreen) > .canvas-tool-menu:not(.canvas-miscellaneous-menu) > summary",
  );
  const normalStyleSummary = page.locator(
    ".canvas-toolbar:not(.is-fullscreen) > .markdown-style-menu > summary",
  );
  await expect(normalStyleSummary).toBeVisible();
  const normalShapeBounds = await normalShapeSummary.boundingBox();
  const normalStyleBounds = await normalStyleSummary.boundingBox();
  if (normalShapeBounds === null || normalStyleBounds === null) {
    throw new Error("Normal toolbar control geometry is unavailable");
  }
  const normalLaserBounds = await page
    .getByRole("button", { name: "Laser", exact: true })
    .boundingBox();
  const normalMiscellaneousSummary = page.locator(
    ".canvas-toolbar:not(.is-fullscreen) .canvas-miscellaneous-menu > summary",
  );
  const normalMiscellaneousBounds = await normalMiscellaneousSummary.boundingBox();
  if (normalLaserBounds === null || normalMiscellaneousBounds === null) {
    throw new Error("Normal toolbar menu geometry is unavailable");
  }
  const laserToShapesGap = normalShapeBounds.x - (normalLaserBounds.x + normalLaserBounds.width);
  const shapesToMiscellaneousGap =
    normalMiscellaneousBounds.x - (normalShapeBounds.x + normalShapeBounds.width);
  expect(Math.abs(laserToShapesGap - shapesToMiscellaneousGap)).toBeLessThan(1);
  expect(normalStyleBounds.x).toBeGreaterThanOrEqual(
    normalShapeBounds.x + normalShapeBounds.width,
  );
  await expect(page.locator(".canvas-toolbar:not(.is-fullscreen) .canvas-tool-menu")).toHaveCount(
    2,
  );
  const normalMiscellaneousIcon = normalMiscellaneousSummary.locator("svg");
  await expect(normalMiscellaneousIcon).toHaveCount(1);
  const summaryAndIconBounds = await normalMiscellaneousSummary.evaluate((summary) => {
    const icon = summary.querySelector("svg");
    if (icon === null) throw new Error("Miscellaneous icon is missing");
    const summaryBounds = summary.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return {
      summaryCenter: summaryBounds.left + summaryBounds.width / 2,
      iconCenter: iconBounds.left + iconBounds.width / 2,
    };
  });
  expect(
    Math.abs(summaryAndIconBounds.summaryCenter - summaryAndIconBounds.iconCenter),
  ).toBeLessThan(1);
  await page.getByLabel("Miscellaneous tools").click();
  const normalMiscellaneousMenu = page.locator(
    ".canvas-toolbar:not(.is-fullscreen) .canvas-miscellaneous-menu .canvas-tool-menu__content",
  );
  await expect(normalMiscellaneousMenu).toBeVisible();
  const insertSpaceIcon = normalMiscellaneousMenu
    .getByRole("button", { name: "Insert space", exact: true })
    .locator("svg");
  await expect(insertSpaceIcon).toHaveCount(1);
  await expect(insertSpaceIcon).toHaveAttribute("viewBox", "0 0 24 24");
  expect(
    await normalMiscellaneousMenu.evaluate((element) => element.offsetWidth),
  ).toBeGreaterThanOrEqual(13 * 16 - 1);
  await page.getByLabel("Miscellaneous tools").click();
  await page.getByText("Shapes", { exact: true }).click();
  await expect(
    page.locator(".canvas-tool-menu:not(.canvas-miscellaneous-menu) .canvas-tool-menu__content"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await expect(page.locator(".canvas-tool-menu[open]")).toHaveCount(0);
  await page.getByText("Shapes", { exact: true }).click();
  await expect(
    page.locator(".canvas-tool-menu:not(.canvas-miscellaneous-menu) .canvas-tool-menu__content"),
  ).toBeVisible();
  await page.getByTitle("Rectangle tool", { exact: true }).click();
  await expect(
    page.locator(
      ".canvas-toolbar:not(.is-fullscreen) .canvas-tool-menu:not(.canvas-miscellaneous-menu) > summary",
    ),
  ).toHaveClass(/is-active/);
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  await expect(page.locator(".canvas-toolbar.is-fullscreen .canvas-tool-menu")).toHaveCount(2);
  await expect(page.locator(".notebook-app[data-fullscreen-phase='open']")).toBeVisible();
  const fullscreenToolbar = page.locator(".canvas-toolbar.is-fullscreen");
  const fullscreenContentAlignment = await fullscreenToolbar.evaluate((toolbar) => {
    const children = [...toolbar.children].filter(
      (child) => !child.classList.contains("canvas-fullscreen-button"),
    );
    const first = children[0]?.getBoundingClientRect();
    const bounds = toolbar.getBoundingClientRect();
    if (first === undefined) {
      throw new Error("Fullscreen toolbar controls are unavailable");
    }
    return {
      toolbarLeft: bounds.left,
      contentLeft: first.left,
    };
  });
  expect(
    fullscreenContentAlignment.contentLeft - fullscreenContentAlignment.toolbarLeft,
  ).toBeLessThan(8);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const fullscreenRadialToggle = page.locator(
    ".canvas-toolbar.is-fullscreen > .radial-toolbar-toggle",
  );
  const fullscreenStyleSummary = page.locator(
    ".canvas-toolbar.is-fullscreen > .radial-toolbar-toggle + .markdown-style-menu > summary",
  );
  await expect(fullscreenStyleSummary).toBeVisible();
  const fullscreenRadialBounds = await fullscreenRadialToggle.boundingBox();
  const fullscreenStyleBounds = await fullscreenStyleSummary.boundingBox();
  if (fullscreenRadialBounds === null || fullscreenStyleBounds === null) {
    throw new Error("Fullscreen toolbar control geometry is unavailable");
  }
  expect(fullscreenStyleBounds.x).toBeGreaterThanOrEqual(
    fullscreenRadialBounds.x + fullscreenRadialBounds.width,
  );
  await page.getByLabel("Miscellaneous tools").click();
  const fullscreenMiscellaneousMenu = page.locator(
    ".canvas-toolbar.is-fullscreen .canvas-miscellaneous-menu .canvas-tool-menu__content",
  );
  await expect(fullscreenMiscellaneousMenu).toBeVisible();
  expect(
    await fullscreenMiscellaneousMenu.evaluate((element) => element.offsetWidth),
  ).toBeGreaterThanOrEqual(13 * 16 - 1);
  await page.getByLabel("Miscellaneous tools").click();
  await page.getByText("Shapes", { exact: true }).click();
  await expect(
    page.locator(".canvas-tool-menu:not(.canvas-miscellaneous-menu) .canvas-tool-menu__content"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await expect(page.locator(".canvas-tool-menu[open]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy selected objects", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste objects", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send selected objects to back", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send selected objects backward", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bring selected objects forward", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bring selected objects to front", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Group selection", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Duplicate selection", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Actions", { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    const menu = document.querySelector(
      ".canvas-tool-menu:not(.canvas-miscellaneous-menu) .canvas-tool-menu__content",
    );
    if (!(menu instanceof HTMLElement)) throw new Error("Shape menu is missing");
    const openingOrigins: string[] = [];
    menu.addEventListener("animationstart", (event) => {
      if (event.animationName === "floating-menu-open") {
        openingOrigins.push(menu.style.getPropertyValue("--menu-origin-y"));
      }
    });
    (window as Window & { __shapeMenuOpeningOrigins?: string[] }).__shapeMenuOpeningOrigins =
      openingOrigins;
  });
  await page.getByText("Shapes", { exact: true }).click();
  const shapeMenu = page.locator(
    ".canvas-tool-menu:not(.canvas-miscellaneous-menu) .canvas-tool-menu__content",
  );
  await expect(shapeMenu).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __shapeMenuOpeningOrigins?: string[] }).__shapeMenuOpeningOrigins
            ?.length ?? 0,
      ),
    )
    .toBe(1);
  expect(
    Number.parseFloat(
      await page.evaluate(
        () =>
          (window as Window & { __shapeMenuOpeningOrigins?: string[] })
            .__shapeMenuOpeningOrigins?.[0] ?? "",
      ),
    ),
  ).toBeLessThan(0);
  await expect
    .poll(() =>
      shapeMenu.evaluate((element) =>
        Number.parseFloat(element.style.getPropertyValue("--menu-origin-y")),
      ),
    )
    .toBeLessThan(0);
  await expect(page.getByTitle("Rectangle tool", { exact: true })).toBeVisible();
  await page.getByTitle("Rectangle tool", { exact: true }).click();
  await expect(
    page.locator(".canvas-tool-menu > summary").filter({ hasText: "Shapes" }),
  ).toHaveClass(/is-active/);
});

test("keeps the fullscreen button icon centered at custom toolbar heights", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();

  const measureIconOffset = async () =>
    page.locator(".canvas-toolbar.is-fullscreen .canvas-fullscreen-button").evaluate((button) => {
      const buttonBounds = button.getBoundingClientRect();
      const icon = button.querySelector("svg");
      if (icon === null) throw new Error("Fullscreen icon is unavailable");
      const iconBounds = icon.getBoundingClientRect();
      return Math.abs(
        buttonBounds.top + buttonBounds.height / 2 - (iconBounds.top + iconBounds.height / 2),
      );
    });

  const measureFullscreenButtonBounds = async () =>
    page.locator(".canvas-toolbar.is-fullscreen .canvas-fullscreen-button").evaluate((button) => {
      const buttonBounds = button.getBoundingClientRect();
      const toolbarBounds = button.parentElement?.getBoundingClientRect();
      if (toolbarBounds === undefined) throw new Error("Fullscreen toolbar is unavailable");
      return {
        width: buttonBounds.width,
        height: buttonBounds.height,
        rightGap: toolbarBounds.right - buttonBounds.right,
      };
    });

  for (const height of [24, 120]) {
    await expect(page.getByRole("button", { name: "Enter fullscreen", exact: true })).toBeVisible();
    await page.locator(".topbar-settings > summary").click();
    const toolbarHeight = page.getByLabel("Canvas toolbar height", { exact: true });
    await toolbarHeight.fill(String(height));
    await toolbarHeight.blur();
    await expect(toolbarHeight).toHaveValue(String(height));
    await page.locator(".topbar-settings > summary").click();
    await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
    await expect(page.locator(".canvas-toolbar.is-fullscreen")).toBeVisible();
    await expect(page.locator(".notebook-app[data-fullscreen-phase='open']")).toBeVisible();
    expect(await measureIconOffset()).toBeLessThan(0.5);
    const fullscreenButtonBounds = await measureFullscreenButtonBounds();
    expect(fullscreenButtonBounds.width).toBeCloseTo(fullscreenButtonBounds.height, 5);
    expect(fullscreenButtonBounds.rightGap).toBeLessThan(8);
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await expect(page.locator(".canvas-toolbar:not(.is-fullscreen)")).toBeVisible();
  }

  await page.locator(".topbar-settings > summary").click();
  const toolbarHeight = page.getByLabel("Canvas toolbar height", { exact: true });
  await toolbarHeight.fill("44");
  await toolbarHeight.blur();
  await expect(toolbarHeight).toHaveValue("44");
});

test("keeps the Edit styles menu below its trigger and inside a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Text", exact: true }).click();

  const trigger = page.locator(".markdown-style-menu > summary");
  const menu = page.locator(".markdown-style-editor");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(page.locator(".markdown-style-menu")).toHaveAttribute("data-menu-phase", "open");
  await expect(menu.getByText("Heading 1", { exact: true })).toBeVisible();
  await expect(menu.getByText("Heading 2", { exact: true })).toBeVisible();
  await expect(menu.getByText("Heading 3", { exact: true })).toBeVisible();
  await expect(menu.getByText("Code background", { exact: true })).toBeVisible();
  await expect(menu.getByText("Heading 1 / section", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Heading 2 / subsection", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("Heading 3 / subsubsection", { exact: true })).toHaveCount(0);
  await expect(menu.locator('input[type="color"]').first()).toHaveCSS("border-top-width", "0px");

  const geometry = await page.evaluate(() => {
    const summary = document.querySelector(".markdown-style-menu > summary");
    const editor = document.querySelector(".markdown-style-editor");
    if (!(summary instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
      throw new Error("Markdown style menu geometry is unavailable");
    }
    const summaryBounds = summary.getBoundingClientRect();
    const editorBounds = editor.getBoundingClientRect();
    return {
      summaryBottom: summaryBounds.bottom,
      editorTop: editorBounds.top,
      editorLeft: editorBounds.left,
      editorRight: editorBounds.right,
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry.editorTop).toBeGreaterThanOrEqual(geometry.summaryBottom);
  expect(geometry.editorLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.editorRight).toBeLessThanOrEqual(geometry.viewportWidth);
});

test("animates the custom palette editor below its palette in fullscreen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  await expect(page.locator(".notebook-app[data-fullscreen-phase='open']")).toBeVisible();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const customToggle = page.getByLabel("Use custom pen colors", { exact: true });
  await customToggle.check();

  await page.evaluate(() => {
    const editor = document.querySelector(".palette-editor");
    if (!(editor instanceof HTMLElement)) throw new Error("Palette editor is missing");
    const animationNames: string[] = [];
    editor.addEventListener("animationstart", (event) => animationNames.push(event.animationName));
    (
      window as Window & { __paletteEditorAnimationNames?: string[] }
    ).__paletteEditorAnimationNames = animationNames;
  });

  await page.getByRole("button", { name: "Use ink color #9ca3af", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "pen custom palette editor", exact: true });
  await expect(editor).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & { __paletteEditorAnimationNames?: string[] }
          ).__paletteEditorAnimationNames?.includes("floating-menu-open") ?? false,
      ),
    )
    .toBe(true);

  const palette = page.getByRole("group", { name: "Ink style", exact: true });
  const paletteBounds = (await palette.boundingBox())!;
  await expect
    .poll(async () => (await editor.boundingBox())?.y ?? 0)
    .toBeGreaterThanOrEqual(paletteBounds.y + paletteBounds.height);
  const editorBounds = (await editor.boundingBox())!;
  expect(Math.abs(editorBounds.x - paletteBounds.x)).toBeLessThan(2);
  expect(editorBounds.y).toBeGreaterThanOrEqual(paletteBounds.y + paletteBounds.height);
  expect(editorBounds.x).toBeGreaterThan(8);
  const glassStyle = await editor.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backdropFilter: style.backdropFilter, backgroundImage: style.backgroundImage };
  });
  expect(glassStyle.backdropFilter).toContain("blur");
  expect(glassStyle.backgroundImage).toContain("linear-gradient");

  await page.getByRole("button", { name: "Use ink color #9ca3af", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & { __paletteEditorAnimationNames?: string[] }
          ).__paletteEditorAnimationNames?.includes("floating-menu-close") ?? false,
      ),
    )
    .toBe(true);
  await expect(editor).toBeHidden();
});

test("opens the fullscreen radial toolbar after a long press and blocks context menus", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.getByLabel("Infinite page canvas");
  await expect(canvas).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Long-press radial toolbar", exact: true }),
  ).toHaveCount(0);

  const contextMenuWasPrevented = await canvas.evaluate((surface) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(contextMenuWasPrevented).toBe(true);

  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  const radialToggle = page.getByRole("checkbox", {
    name: "Enable long-press radial toolbar",
    exact: true,
  });
  await expect(radialToggle).toBeChecked();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.getByRole("button", { name: "Use ink color #fb923c", exact: true }).click();
  await page.getByLabel("Ink thickness", { exact: true }).fill("30");

  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");
  const radialX = bounds.x + bounds.width / 2;
  const radialY = bounds.y + bounds.height / 2;
  const ink = page.locator('[data-canvas-element-id].kind-ink');
  const inkCount = await ink.count();
  await drag(page, radialX - 140, radialY - 82, 280, 0);
  await expect(ink).toHaveCount(inkCount + 1);
  await page.mouse.move(radialX, radialY);
  await page.mouse.down();
  await page.waitForTimeout(550);
  const radialMenu = page.getByRole("dialog", {
    name: "Long-press radial toolbar",
    exact: true,
  });
  await expect(radialMenu).toBeVisible();
  await expect
    .poll(() => radialMenu.evaluate((menu) => getComputedStyle(menu).transform))
    .toBe("none");
  const radialOpeningComposition = await radialMenu.evaluate((menu) => {
    const glass = menu.querySelector(".canvas-radial-menu__glass-layer");
    if (glass === null) throw new Error("Radial glass layer is unavailable");
    const menuStyle = getComputedStyle(menu);
    const glassStyle = getComputedStyle(glass);
    return {
      glassAnimationName: glassStyle.animationName,
      glassOpacity: glassStyle.opacity,
      menuAnimationName: menuStyle.animationName,
    };
  });
  expect(radialOpeningComposition.menuAnimationName).toBe("none");
  expect(radialOpeningComposition.glassAnimationName).toBe("canvas-radial-menu-glass-open");
  expect(radialOpeningComposition.glassOpacity).toBe("1");
  await expect(radialMenu.getByRole("button", { name: /Choose text tool/ })).toBeVisible();
  await expect(radialMenu.getByRole("button", { name: /Choose laser tool/ })).toBeVisible();
  await expect(radialMenu.getByRole("button", { name: /Radial color/ })).toHaveCount(6);
  await expect(radialMenu.locator(".canvas-radial-menu__sector-shape")).toHaveCount(11);
  await expect(
    radialMenu.getByRole("button", { name: "Choose pen tool in radial toolbar" }),
  ).toHaveAttribute("data-radial-angle", "-90");
  await page.mouse.up();
  expect(
    await radialMenu.evaluate(
      (menu, point) => {
        const topCanvasLayer = document
          .elementsFromPoint(point.x, point.y)
          .find(
            (element) =>
              element.closest(".canvas-radial-menu") !== null ||
              element.closest("[data-canvas-element-id]") !== null,
          );
        return topCanvasLayer !== undefined && menu.contains(topCanvasLayer);
      },
      { x: radialX, y: radialY - 82 },
    ),
  ).toBe(true);

  const penSector = radialMenu.getByRole("button", {
    name: "Choose pen tool in radial toolbar",
  });
  const selectedToolSector = radialMenu.locator(".canvas-radial-menu__tool.is-active");
  await expect(selectedToolSector).toHaveCount(1);
  const glassLayer = radialMenu.locator(".canvas-radial-menu__glass-layer");
  await expect(glassLayer).toHaveCount(1);
  const glassLayerStyle = await glassLayer.evaluate((glass) => {
    const style = getComputedStyle(glass);
    return { background: style.background, backdropFilter: style.backdropFilter };
  });
  expect(glassLayerStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(glassLayerStyle.backdropFilter).toContain("blur");

  const colorSector = radialMenu.getByRole("button", { name: /Radial color/ }).first();
  const colorSectorStyle = await colorSector
    .locator(".canvas-radial-menu__sector-shape")
    .evaluate((shape) => {
      const style = getComputedStyle(shape);
      return { fill: style.fill, filter: style.filter, backdropFilter: style.backdropFilter };
    });
  expect(colorSectorStyle.fill).not.toBe("rgba(0, 0, 0, 0)");
  expect(colorSectorStyle.filter).toBe("none");
  expect(colorSectorStyle.backdropFilter).toBe("none");
  await colorSector.hover();
  const sectorGlow = radialMenu.locator(".canvas-radial-menu__sector-glow");
  await expect(sectorGlow).toBeVisible();
  const glowStyle = await sectorGlow.evaluate((glow) => {
    const style = getComputedStyle(glow);
    return { filter: style.filter, transitionDuration: style.transitionDuration };
  });
  expect(glowStyle.filter).not.toBe("none");
  expect(glowStyle.transitionDuration).toBe("0s");

  await penSector.click();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveClass(/is-active/);

  await radialToggle.uncheck();
  await expect(radialMenu).toHaveCount(0);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await expect(radialMenu).toHaveCount(0);
});
