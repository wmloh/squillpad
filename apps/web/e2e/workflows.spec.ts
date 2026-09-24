import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function openFreshPage(page: Page): Promise<Locator> {
  const pages = page.locator(".page-list > li > .page-select");
  await expect(page.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  const count = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(count + 1);
  await pages.last().click();
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  return page.getByLabel("Infinite page canvas");
}

async function chooseRectangle(page: Page) {
  await page.getByText("Shapes", { exact: true }).click();
  await page.getByTitle("Rectangle tool", { exact: true }).click();
}

async function cameraPosition(canvas: Locator): Promise<{ x: number; y: number }> {
  return canvas.evaluate((surface) => {
    const [x = "0", y = "0"] = surface.style.backgroundPosition.split(/\s+/u);
    return { x: Number.parseFloat(x), y: Number.parseFloat(y) };
  });
}

test("renders a near-stationary pen stroke with complete round caps", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.mouse.move(bounds.x + 240, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 241, bounds.y + 180);
  await page.mouse.up();

  const path = page.locator(".canvas-element.kind-ink .canvas-vector path");
  await expect(path).toHaveCount(1);
  const data = await path.getAttribute("d");
  expect(data).toContain("Q 5 2");
  expect(data).toContain("Q 0 2");
});

test("temporarily pans with Space from another canvas tool", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const before = await canvas.evaluate((surface) => surface.style.backgroundPosition);
  const elementCount = await page.locator(".canvas-element").count();
  await page.keyboard.down("Space");
  await page.mouse.move(bounds.x + 180, bounds.y + 140);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 260, bounds.y + 190, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");

  await expect
    .poll(() => canvas.evaluate((surface) => surface.style.backgroundPosition))
    .not.toBe(before);
  await expect(page.locator(".canvas-element")).toHaveCount(elementCount);
});

test("pans both axes with the wheel while Space is held", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hand" })).toHaveAttribute(
    "title",
    "Hand (M; hold Space to drag or scroll; add Shift to scroll sideways)",
  );
  await page.mouse.move(bounds.x + 180, bounds.y + 140);
  const before = await cameraPosition(canvas);
  const zoom = page.getByLabel("Zoom level");
  const initialZoom = await zoom.textContent();

  await page.keyboard.down("Space");
  await page.mouse.wheel(80, 120);
  await expect.poll(() => cameraPosition(canvas)).toEqual({
    x: before.x - 80,
    y: before.y - 120,
  });
  await expect(zoom).toHaveText(initialZoom ?? "");

  const beforeSideScroll = await cameraPosition(canvas);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 100);
  await expect.poll(() => cameraPosition(canvas)).toEqual({
    x: beforeSideScroll.x - 100,
    y: beforeSideScroll.y,
  });
  await expect(zoom).toHaveText(initialZoom ?? "");
  await page.keyboard.up("Shift");

  await page.keyboard.up("Space");
  await page.mouse.wheel(0, 120);
  await expect(zoom).not.toHaveText(initialZoom ?? "");
});

test("pans with arrow keys but leaves the camera still while editing Markdown", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  await canvas.focus();

  const directions = [
    { key: "ArrowLeft", axis: "x", sign: 1 },
    { key: "ArrowRight", axis: "x", sign: -1 },
    { key: "ArrowUp", axis: "y", sign: 1 },
    { key: "ArrowDown", axis: "y", sign: -1 },
  ] as const;
  for (const { key, axis, sign } of directions) {
    const before = await cameraPosition(canvas);
    await page.keyboard.down(key);
    await page.waitForTimeout(80);
    const during = await cameraPosition(canvas);
    await page.waitForTimeout(120);
    const after = await cameraPosition(canvas);
    await page.keyboard.up(key);
    expect(during[axis] * sign).toBeGreaterThan(before[axis] * sign);
    expect(after[axis] * sign).toBeGreaterThan(during[axis] * sign);
  }

  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 120, bounds.y + 100);
  await expect(page.locator(".cm-content")).toBeVisible();

  const beforeEditingArrow = await cameraPosition(canvas);
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(100);
  const duringEditingArrow = await cameraPosition(canvas);
  await page.keyboard.up("ArrowRight");
  expect(duringEditingArrow).toEqual(beforeEditingArrow);
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
});

test("opens an existing Markdown box with one click from the Text tool", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 160, bounds.y + 120);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.insertText("Existing text");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const markdown = page.locator(".canvas-element.kind-markdown");
  await expect(markdown).toContainText("Existing text");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await markdown.click();
  await expect(page.locator(".markdown-editor-popover.is-open")).toBeVisible();
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(page.locator(".markdown-editor-popover.is-open")).toHaveCount(0);
  await markdown.click();
  await expect(page.locator(".markdown-editor-popover.is-open")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(markdown).toContainText("Existing text updated");
});

test("centers fullscreen Markdown editing horizontally without vertical panning", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const initialBounds = await canvas.boundingBox();
  if (initialBounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(initialBounds.x + 500, initialBounds.y + 180);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.insertText(
    [
      "Fullscreen editor positioning",
      ...Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`),
    ].join("\n\n"),
  );
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const markdown = page.locator(".canvas-element.kind-markdown");
  await expect(markdown).toContainText("Fullscreen editor positioning");
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();

  const beforeCanvasBounds = await canvas.boundingBox();
  const beforeMarkdownBounds = await markdown.boundingBox();
  if (beforeCanvasBounds === null || beforeMarkdownBounds === null) {
    throw new Error("Fullscreen Markdown geometry is unavailable before editing");
  }
  expect(
    Math.abs(
      beforeMarkdownBounds.y + beforeMarkdownBounds.height / 2 -
        (beforeCanvasBounds.y + beforeCanvasBounds.height / 2),
    ),
  ).toBeGreaterThan(50);
  const beforeEditing = await cameraPosition(canvas);
  await markdown.dblclick({ position: { x: 24, y: 24 } });
  const editor = page.locator(".markdown-editor-popover.is-open");
  await expect(editor).toBeVisible();
  const canvasBounds = await canvas.boundingBox();
  const markdownBounds = await markdown.boundingBox();
  const editorBounds = await editor.boundingBox();
  if (canvasBounds === null || markdownBounds === null || editorBounds === null) {
    throw new Error("Fullscreen Markdown geometry is unavailable");
  }

  expect(markdownBounds.x + markdownBounds.width / 2).toBeCloseTo(
    canvasBounds.x + canvasBounds.width / 2,
    0,
  );
  expect(markdownBounds.height).toBeGreaterThan(400);
  expect((await cameraPosition(canvas)).y).toBe(beforeEditing.y);
  expect(editorBounds.x).toBeLessThan(canvasBounds.x + canvasBounds.width / 2);
  expect(editorBounds.x - canvasBounds.x).toBeLessThan(24);
});

test("keeps only customized Markdown editor layouts for the browser session", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const canvasBounds = await canvas.boundingBox();
  if (canvasBounds === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(canvasBounds.x + 240, canvasBounds.y + 160);
  await page.keyboard.insertText("Customized editor");

  const editor = page.locator(".markdown-editor-popover.is-open");
  await expect(editor).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("squillpad:markdown-editor-layout:")).length),
  ).toBe(0);
  const initial = await editor.boundingBox();
  if (initial === null) throw new Error("Markdown editor bounds are unavailable");

  const move = page.getByRole("button", { name: "Move Markdown editor" });
  await move.click();
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("squillpad:markdown-editor-layout:")).length),
  ).toBe(0);
  const moveBounds = await move.boundingBox();
  if (moveBounds === null) throw new Error("Move handle bounds are unavailable");
  await drag(page, moveBounds.x + 45, moveBounds.y + moveBounds.height / 2, 90, -45);
  await expect(editor).toHaveClass(/is-custom-layout/u);
  const moved = await editor.boundingBox();
  if (moved === null) throw new Error("Moved editor bounds are unavailable");
  expect(moved.x).toBeGreaterThan(initial.x + 70);
  expect(moved.y).toBeLessThan(initial.y - 25);

  const resize = page.getByRole("button", { name: "Resize Markdown editor" });
  const resizeBounds = await resize.boundingBox();
  if (resizeBounds === null) throw new Error("Resize handle bounds are unavailable");
  await drag(page, resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + resizeBounds.height / 2, 110, 65);
  const customized = await editor.boundingBox();
  if (customized === null) throw new Error("Resized editor bounds are unavailable");
  expect(customized.width).toBeGreaterThan(moved.width + 80);
  expect(customized.height).toBeGreaterThan(moved.height + 45);
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("squillpad:markdown-editor-layout:")).length),
  ).toBe(1);

  await page.getByRole("button", { name: "Close Markdown editor" }).click();
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await page.locator(".canvas-element.kind-markdown").dblclick();
  await expect(editor).toBeVisible();
  const fullscreen = await editor.boundingBox();
  if (fullscreen === null) throw new Error("Fullscreen editor bounds are unavailable");
  expect(fullscreen.width).toBeCloseTo(customized.width, 0);
  expect(fullscreen.height).toBeCloseTo(customized.height, 0);
  const fullscreenMoveBounds = await move.boundingBox();
  if (fullscreenMoveBounds === null) throw new Error("Fullscreen move handle bounds are unavailable");
  await drag(page, fullscreenMoveBounds.x + 45, fullscreenMoveBounds.y + fullscreenMoveBounds.height / 2, 35, 30);
  const fullscreenMoved = await editor.boundingBox();
  if (fullscreenMoved === null) throw new Error("Moved fullscreen editor bounds are unavailable");
  expect(fullscreenMoved.x).toBeGreaterThan(fullscreen.x + 20);
  const fullscreenResizeBounds = await resize.boundingBox();
  if (fullscreenResizeBounds === null) throw new Error("Fullscreen resize handle bounds are unavailable");
  await drag(page, fullscreenResizeBounds.x + 8, fullscreenResizeBounds.y + 8, 40, 25);
  const fullscreenResized = await editor.boundingBox();
  if (fullscreenResized === null) throw new Error("Resized fullscreen editor bounds are unavailable");
  expect(fullscreenResized.width).toBeGreaterThan(fullscreenMoved.width + 25);
  await page.getByRole("button", { name: "Close Markdown editor" }).click();
  await page.reload();
  await page.locator(".canvas-element.kind-markdown").dblclick();
  await expect(editor).toHaveClass(/is-custom-layout/u);
  const restored = await editor.boundingBox();
  if (restored === null) throw new Error("Restored editor bounds are unavailable");
  expect(restored.width).toBeCloseTo(fullscreenResized.width, 0);
  expect(restored.height).toBeCloseTo(fullscreenResized.height, 0);

  await page.getByRole("button", { name: "Close Markdown editor" }).click();
  await expect(editor).toHaveCount(0);
  const secondCanvas = await openFreshPage(page);
  const secondCanvasBounds = await secondCanvas.boundingBox();
  if (secondCanvasBounds === null) throw new Error("Second canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(secondCanvasBounds.x + 800, secondCanvasBounds.y + 600);
  await expect(editor).not.toHaveClass(/is-custom-layout/u);
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("squillpad:markdown-editor-layout:")).length),
  ).toBe(1);
  await page.keyboard.insertText("Default editor");
  await page.getByRole("button", { name: "Close Markdown editor" }).click();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.locator(".canvas-element.kind-markdown").last().dblclick();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Move Markdown editor" }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Resize Markdown editor" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(editor).not.toHaveClass(/is-custom-layout/u);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("squillpad:markdown-editor-layout:")).length)).toBe(1);
});

test("keeps empty Markdown editor footer controls usable in windowed and fullscreen modes", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);

  const exerciseEmptyEditorFooter = async () => {
    const bounds = await canvas.boundingBox();
    if (bounds === null) throw new Error("Canvas bounds are unavailable");

    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

    const editor = page.locator(".markdown-editor-popover.is-open");
    const colorStyle = page.getByLabel("Markdown color style");
    const createGroup = page.getByRole("button", {
      name: "Create text box group",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await expect(createGroup).toBeEnabled();

    await colorStyle.click();
    await expect(editor).toBeVisible();
    await createGroup.click();
    await expect(editor).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add text box below", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
    await expect(editor).toHaveCount(0);
  };

  await exerciseEmptyEditorFooter();
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  await exerciseEmptyEditorFooter();

  const fullscreenBounds = await canvas.boundingBox();
  if (fullscreenBounds === null) throw new Error("Fullscreen canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(
    fullscreenBounds.x + fullscreenBounds.width / 2,
    fullscreenBounds.y + fullscreenBounds.height / 2,
  );
  await expect(page.locator(".markdown-editor-popover.is-open")).toBeVisible();
  await page.mouse.click(
    fullscreenBounds.x + fullscreenBounds.width - 24,
    fullscreenBounds.y + fullscreenBounds.height - 24,
  );
  await expect(page.locator(".markdown-editor-popover.is-open")).toHaveCount(0);
});

test("keeps a LAN client editable in fullscreen", async ({ page }) => {
  let storageDiagnosticsRequests = 0;
  await page.route("**/api/storage/diagnostics", async (route) => {
    storageDiagnosticsRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        canonicalBytes: 120,
        canonicalFileCount: 3,
        runtimeCacheBytes: 40,
        runtimeCacheFileCount: 2,
      }),
    });
  });
  await page.route("**/api/auth/status", async (route) => {
    const response = await route.fetch();
    const status = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      status: 200,
      json: {
        ...status,
        authenticated: true,
        hostAuthorized: false,
        username: "reader",
        profileSettingsAvailable: false,
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  await expect(page.locator(".storage-diagnostics")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear runtime cache", exact: true })).toHaveCount(
    0,
  );
  expect(storageDiagnosticsRequests).toBe(0);
  await openFreshPage(page);

  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  await expect(page.locator(".canvas-toolbar.is-fullscreen")).not.toHaveClass(/is-read-only/);
});

test("creates and reopens a complete mixed page workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New section", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Sections" }).locator("li");
  await expect(sections).toHaveCount(2);
  const newSection = sections.last();
  await newSection.locator(".section-select").click();
  await expect(newSection).toHaveClass(/is-active/);
  await expect(page.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  const canvas = await openFreshPage(page);
  const canvasBounds = await canvas.boundingBox();
  if (canvasBounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(canvasBounds.x + 160, canvasBounds.y + 130);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".markdown-editor-popover .cm-gutters")).toHaveCount(0);
  await page.keyboard.insertText("# Math workflow\n\nInline $x^2$ and display:\n\n$$y = mx + b$$");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(page.locator(".kind-markdown .katex")).toHaveCount(2);
  await expect(page.locator(".kind-markdown .katex-display")).toHaveCSS("display", "block");
  await expect(page.locator(".kind-markdown .katex-display")).toHaveCSS("text-align", "center");

  const markdown = page.locator(".canvas-element.kind-markdown");
  expect(await markdown.evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
  const beforeMove = await markdown.getAttribute("style");
  const markdownBounds = await markdown.boundingBox();
  if (markdownBounds === null) throw new Error("Markdown bounds are unavailable");
  await drag(
    page,
    markdownBounds.x + markdownBounds.width / 2,
    markdownBounds.y + markdownBounds.height / 2,
    40,
    24,
  );
  expect(await markdown.getAttribute("style")).not.toBe(beforeMove);
  await expect(page.locator(".canvas-resize-handle")).toHaveCount(8);
  const resizeHandle = await page.locator(".canvas-resize-handle.is-e").boundingBox();
  if (resizeHandle === null) throw new Error("Markdown resize handle is unavailable");
  expect(
    await page
      .locator(".canvas-resize-handle.is-e")
      .evaluate((element) => getComputedStyle(element).touchAction),
  ).toBe("none");
  const widthBeforeResize = await markdown.evaluate(
    (element) => (element as HTMLElement).style.width,
  );
  await drag(
    page,
    resizeHandle.x + resizeHandle.width / 2,
    resizeHandle.y + resizeHandle.height / 2,
    70,
    0,
  );
  expect(await markdown.evaluate((element) => (element as HTMLElement).style.width)).not.toBe(
    widthBeforeResize,
  );

  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await drag(page, canvasBounds.x + 450, canvasBounds.y + 220, 180, 24);
  await expect(page.locator(".kind-ink")).toHaveCount(1);

  await chooseRectangle(page);
  await drag(page, canvasBounds.x + 560, canvasBounds.y + 320, 100, 70);
  await expect(page.locator(".kind-shape")).toHaveCount(1);

  await page.getByRole("button", { name: "Select", exact: true }).click();
  const shape = page.locator(".canvas-element.kind-shape");
  const shapeBounds = await shape.boundingBox();
  if (shapeBounds === null) throw new Error("Shape bounds are unavailable");
  await page.mouse.click(
    shapeBounds.x + shapeBounds.width / 2,
    shapeBounds.y + shapeBounds.height / 2,
  );
  await page.keyboard.press("Delete");
  await expect(shape).toHaveCount(0);

  const ink = page.locator(".kind-ink");
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  const eraserInkBounds = await ink.boundingBox();
  if (eraserInkBounds === null) throw new Error("Ink bounds are unavailable after selecting Erase");
  await page.mouse.move(
    eraserInkBounds.x + eraserInkBounds.width / 2,
    eraserInkBounds.y - 12,
  );
  await page.mouse.down();
  await page.mouse.move(
    eraserInkBounds.x + eraserInkBounds.width / 2,
    eraserInkBounds.y + eraserInkBounds.height + 12,
    { steps: 8 },
  );
  const eraserTrace = page.locator(".canvas-eraser-trace");
  await expect(eraserTrace).toBeVisible();
  const traceZIndex = Number(
    await eraserTrace.evaluate((element) => getComputedStyle(element).zIndex),
  );
  const elementZIndexes = await page
    .locator(".canvas-element")
    .evaluateAll((elements) => elements.map((element) => Number(getComputedStyle(element).zIndex)));
  expect(traceZIndex).toBeGreaterThan(Math.max(...elementZIndexes));
  await page.mouse.up();
  await expect(ink).toHaveCount(0);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".kind-ink")).toHaveCount(1);

  await page.waitForTimeout(700);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const route = new URL(page.url()).hash;
  await page.request.get("http://127.0.0.1:4273/e2e/reopen");
  await page.reload();
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe(route);
  await expect(page.locator(".kind-markdown .katex")).toHaveCount(2);
  await expect(page.locator(".kind-ink")).toHaveCount(1);
  await expect(page.locator(".kind-shape")).toHaveCount(0);
});

test("selects a different page with a normal click", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();

  const pageItems = page.locator(".page-list > li[data-reorder-id]");
  const pageSelects = pageItems.locator(".page-select");
  const newPage = page.getByRole("button", { name: "New page", exact: true });
  let pageCount = await pageItems.count();
  while (pageCount < 2) {
    await newPage.click();
    pageCount += 1;
    await expect(pageItems).toHaveCount(pageCount);
  }

  await pageSelects.first().click();
  await expect(pageItems.first()).toHaveClass(/is-active/);
  await expect(pageItems.nth(1)).not.toHaveClass(/is-active/);
  await pageSelects.nth(1).click();
  await expect(pageItems.nth(1)).toHaveClass(/is-active/);
  await expect(pageItems.first()).not.toHaveClass(/is-active/);
});

test("fits loose Markdown checklist content without vertical overflow", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 120, bounds.y + 100);
  await page.keyboard.insertText("- [ ] a\n  \n- [ ] b\n\nasdasd");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const markdownBlock = page.locator(".canvas-element.kind-markdown .markdown-block");
  await expect(markdownBlock).toContainText("asdasd");
  await expect
    .poll(() => markdownBlock.evaluate((element) => element.scrollHeight <= element.clientHeight))
    .toBe(true);
});

test("navigates Markdown footnotes without scrolling the canvas surface", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 120, bounds.y + 100);
  const paragraphs = Array.from({ length: 42 }, (_, index) => `Paragraph ${index + 1}.`).join(
    "\n\n",
  );
  await page.keyboard.insertText(`${paragraphs}\n\nReferenced[^1]\n\n[^1]: Footnote destination.`);
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const markdown = page.locator(".canvas-element.kind-markdown");
  const initialRoute = new URL(page.url()).hash;
  const readStatusGeometry = () =>
    canvas.evaluate((surface) => {
      const statusElement = surface.parentElement?.querySelector<HTMLElement>(".canvas-status");
      if (statusElement === null) throw new Error("Canvas status is unavailable");
      const surfaceRect = surface.getBoundingClientRect();
      const statusRect = statusElement.getBoundingClientRect();
      return {
        bottomGap: surfaceRect.bottom - statusRect.bottom,
        scrollTop: surface.scrollTop,
      };
    });
  const before = await readStatusGeometry();

  await page.locator("a[data-footnote-ref]").first().click();
  await expect.poll(async () => (await readStatusGeometry()).scrollTop).toBe(0);
  await expect
    .poll(async () => {
      const footnote = await page.locator(".footnotes li").first().boundingBox();
      const surface = await canvas.boundingBox();
      return (
        footnote !== null &&
        surface !== null &&
        footnote.y >= surface.y &&
        footnote.y < surface.y + surface.height
      );
    })
    .toBe(true);
  expect(await readStatusGeometry()).toMatchObject({ bottomGap: before.bottomGap, scrollTop: 0 });
  expect(new URL(page.url()).hash).toBe(initialRoute);

  await page.locator("[data-footnote-backref]").first().click();
  await expect.poll(async () => (await readStatusGeometry()).scrollTop).toBe(0);
  expect(new URL(page.url()).hash).toBe(initialRoute);

  await markdown.dblclick();
  const editor = page.locator(".markdown-editor-popover.is-open");
  await expect(editor).toBeVisible();
  const editorBounds = await editor.boundingBox();
  const canvasAfterEdit = await canvas.boundingBox();
  if (editorBounds === null || canvasAfterEdit === null) {
    throw new Error("Markdown editor or canvas bounds are unavailable");
  }
  expect(editorBounds.y).toBeGreaterThanOrEqual(canvasAfterEdit.y);
  expect(editorBounds.y + editorBounds.height).toBeLessThanOrEqual(
    canvasAfterEdit.y + canvasAfterEdit.height,
  );
});

test("attaches an ungrouped text box to a group with drop feedback", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 180, bounds.y + 120);
  await page.keyboard.insertText("Group block");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close Markdown editor", exact: true }),
  ).toHaveCount(0);
  const blocks = page.locator(".canvas-element.kind-markdown");
  const groupSource = blocks.first();
  await groupSource.dblclick();
  await page.getByRole("button", { name: "Create text box group", exact: true }).click();
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close Markdown editor", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 700, bounds.y + 160);
  await page.keyboard.insertText("Attach me");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close Markdown editor", exact: true }),
  ).toHaveCount(0);

  const group = page.locator(".canvas-text-box-group");
  const groupBounds = await group.boundingBox();
  const dragHandle = blocks.last().locator(".canvas-markdown-drag-handle");
  const handleBounds = await dragHandle.boundingBox();
  if (groupBounds === null || handleBounds === null) {
    throw new Error("Text box group or drag handle is unavailable");
  }

  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    groupBounds.x + groupBounds.width / 2,
    groupBounds.y + groupBounds.height / 2,
    { steps: 8 },
  );
  await expect(group).toHaveClass(/is-drop-target/);
  const dropLine = group.locator(".canvas-text-box-group-drop-line");
  await expect(dropLine).toBeVisible();
  await expect(dropLine).toHaveCSS("border-top-style", "dotted");
  await expect(page.getByText("Release to attach", { exact: true })).toBeVisible();
  await page.mouse.up();

  await expect(group).not.toHaveClass(/is-drop-target/);
  expect(await blocks.last().evaluate((element) => (element as HTMLElement).style.left)).toBe(
    await blocks.first().evaluate((element) => (element as HTMLElement).style.left),
  );
});

test("supports source-only Markdown, lasso, inserted space, space removal, and laser trails", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 120, bounds.y + 100);
  await page.keyboard.insertText("# Editable\n\n**Rendered block**");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  const markdown = page.locator(".canvas-element.kind-markdown");
  await markdown.dblclick();
  await expect(page.locator(".markdown-editor-popover .markdown-source-editor")).toBeVisible();
  await expect(markdown.locator(".markdown-inline-editor")).toHaveCount(0);
  await expect(markdown.locator(".markdown-preview-layer strong")).toHaveCount(1);
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  await chooseRectangle(page);
  await drag(page, bounds.x + 480, bounds.y + 260, 90, 70);
  const shape = page.locator(".canvas-element.kind-shape");
  const shapeBounds = await shape.boundingBox();
  if (shapeBounds === null) throw new Error("Shape bounds are unavailable");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.move(shapeBounds.x - 20, shapeBounds.y - 20);
  await page.mouse.down();
  await page.mouse.move(shapeBounds.x + shapeBounds.width + 20, shapeBounds.y - 20);
  await page.mouse.move(
    shapeBounds.x + shapeBounds.width + 20,
    shapeBounds.y + shapeBounds.height + 20,
  );
  await page.mouse.move(shapeBounds.x - 20, shapeBounds.y + shapeBounds.height + 20);
  await page.mouse.move(shapeBounds.x - 20, shapeBounds.y - 20);
  await page.mouse.up();
  await expect(shape).toHaveClass(/is-selected/);

  const topBeforeSpace = Number.parseFloat(await shape.evaluate((node) => node.style.top));
  await page.getByLabel("Miscellaneous tools").click();
  await page.getByRole("button", { name: "Insert space", exact: true }).click();
  await drag(page, bounds.x + 350, shapeBounds.y - 5, 0, 60);
  const topAfterSpace = Number.parseFloat(await shape.evaluate((node) => node.style.top));
  expect(topAfterSpace).toBeGreaterThan(topBeforeSpace + 50);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  expect(Number.parseFloat(await shape.evaluate((node) => node.style.top))).toBe(topBeforeSpace);

  await drag(page, bounds.x + 350, shapeBounds.y - 5, 0, -60);
  const topAfterRemoval = Number.parseFloat(await shape.evaluate((node) => node.style.top));
  expect(topAfterRemoval).toBeLessThan(topBeforeSpace - 50);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  expect(Number.parseFloat(await shape.evaluate((node) => node.style.top))).toBe(topBeforeSpace);

  await page.getByRole("button", { name: "Laser", exact: true }).click();
  await page.mouse.move(bounds.x + 300, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 420, bounds.y + 220, { steps: 6 });
  await expect(page.locator(".canvas-laser-trail.is-active")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".canvas-laser-trail.is-fading")).toBeVisible();
  await expect(page.locator(".canvas-laser-trail")).toHaveCount(0, { timeout: 1_500 });
});

test("keeps footer control edges highlighted on hover", async ({ page }) => {
  await page.goto("/");
  for (const selector of [".theme-toggle", ".navigation-toggle"]) {
    const control = page.locator(`.section-rail__footer ${selector}`);
    expect(await control.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe(
      "1px",
    );
    const normalBackground = await control.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await control.hover();
    await expect
      .poll(() => control.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe(normalBackground);
  }
});

test("keeps controls and toolbar labels out of text selection", async ({ page }) => {
  await page.goto("/");
  const toolbar = page.locator(".canvas-toolbar");
  await expect(toolbar).toBeVisible();

  const controlStyles = await page
    .locator("button, summary, [role='button']")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          userSelect: style.userSelect,
          webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
        };
      }),
    );
  expect(controlStyles.length).toBeGreaterThan(0);
  expect(
    controlStyles.every(
      ({ userSelect, webkitUserSelect }) => userSelect === "none" && webkitUserSelect === "none",
    ),
  ).toBe(true);

  const staticToolbarStyles = await toolbar
    .locator("*:not(input):not(select):not(option):not(textarea)")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          userSelect: style.userSelect,
          webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
        };
      }),
    );
  expect(staticToolbarStyles.length).toBeGreaterThan(0);
  expect(
    staticToolbarStyles.every(
      ({ userSelect, webkitUserSelect }) => userSelect === "none" && webkitUserSelect === "none",
    ),
  ).toBe(true);

  const toolbarStyle = await toolbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      userSelect: style.userSelect,
      webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
      webkitTapHighlightColor: style.getPropertyValue("-webkit-tap-highlight-color"),
    };
  });
  expect(toolbarStyle).toEqual({
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTapHighlightColor: "rgba(0, 0, 0, 0)",
  });

  await page.getByRole("button", { name: "Erase", exact: true }).click();
  const eraserMode = toolbar.getByLabel("Eraser mode");
  await expect(eraserMode).toBeVisible();
  const eraserModeStyle = await eraserMode.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      userSelect: style.userSelect,
      webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
      webkitTapHighlightColor: style.getPropertyValue("-webkit-tap-highlight-color"),
    };
  });
  expect(eraserModeStyle).toEqual({
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTapHighlightColor: "rgba(0, 0, 0, 0)",
  });
  const searchStyle = await page.getByLabel("Search Markdown text").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      userSelect: style.userSelect,
      webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
    };
  });
  expect(searchStyle.userSelect).not.toBe("none");
  expect(searchStyle.webkitUserSelect).not.toBe("none");
});

test("keeps pen and eraser thickness preferences independent", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();

  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const penThickness = page.getByLabel("Ink thickness", { exact: true });
  await penThickness.fill("30");
  await expect(penThickness).toHaveValue("30");

  await page.getByRole("button", { name: "Erase", exact: true }).click();
  const eraserThickness = page.getByLabel("Eraser thickness", { exact: true });
  await expect(eraserThickness).toHaveAttribute("min", "2");
  await expect(eraserThickness).toHaveAttribute("max", "30");
  await expect(eraserThickness).toHaveAttribute("step", "1");
  await expect(eraserThickness).toHaveValue("14");
  await eraserThickness.fill("6");
  await expect(eraserThickness).toHaveValue("6");

  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await expect(page.getByLabel("Ink thickness", { exact: true })).toHaveValue("30");
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  await expect(page.getByLabel("Eraser thickness", { exact: true })).toHaveValue("6");
});

test("does not select settings contents when the menu is reopened quickly", async ({ page }) => {
  await page.goto("/");
  const summary = page.locator(".section-settings > summary");
  const menu = page.locator(".section-settings__menu");
  await expect(summary).toBeVisible();
  await page.evaluate(() => {
    const details = document.querySelector(".section-settings");
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("Settings disclosure is missing");
    }
    const closeAnimationOpenStates: boolean[] = [];
    details.addEventListener("animationstart", (event) => {
      if (event.animationName === "floating-menu-close") {
        closeAnimationOpenStates.push(details.open);
      }
    });
    (window as Window & { __closeAnimationOpenStates?: boolean[] }).__closeAnimationOpenStates =
      closeAnimationOpenStates;
  });
  await summary.click();
  const settingsGroup = page.getByRole("group", { name: "Settings", exact: true });
  await expect(settingsGroup).toBeVisible();
  const settingsGlassStyle = await menu.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backdropFilter: style.backdropFilter, backgroundImage: style.backgroundImage };
  });
  expect(settingsGlassStyle.backdropFilter).toContain("blur");
  expect(settingsGlassStyle.backgroundImage).toContain("linear-gradient");
  await summary.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __closeAnimationOpenStates?: boolean[] }).__closeAnimationOpenStates
            ?.length ?? 0,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __closeAnimationOpenStates?: boolean[] }).__closeAnimationOpenStates,
    ),
  ).toEqual([true]);
  await summary.click();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await expect
    .poll(() => page.locator(".section-settings").getAttribute("data-menu-phase"))
    .toBe("open");
  expect(await menu.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __closeAnimationOpenStates?: boolean[] }).__closeAnimationOpenStates,
    ),
  ).toEqual([true]);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("shows host project-settings controls and imports a portable setting", async ({ page }) => {
  await page.goto("/");
  await page.locator(".section-settings > summary").click();

  const exportButton = page.getByRole("button", { name: "Export project", exact: true });
  const importButton = page.getByRole("button", { name: "Import project", exact: true });
  await expect(exportButton).toBeVisible();
  await expect(importButton).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("squillpad-project-settings.json");

  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
    name: "project-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "squillpad-project-settings",
        schemaVersion: 1,
        settings: { defaultZoom: 1.75 },
      }),
    ),
  });

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/project/settings/export");
      const exported = (await response.json()) as { settings?: { defaultZoom?: number } };
      return exported.settings?.defaultZoom;
    })
    .toBe(1.75);
});

test("keeps the Settings menu below its trigger and inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 700 });
  await page.goto("/");

  const trigger = page.locator(".section-settings > summary");
  const menu = page.locator(".section-settings__menu");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(page.locator(".section-settings")).toHaveAttribute("data-menu-phase", "open");

  const geometry = await page.evaluate(() => {
    const summary = document.querySelector(".section-settings > summary");
    const menu = document.querySelector(".section-settings__menu");
    if (!(summary instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error("Settings menu geometry is unavailable");
    }
    const summaryBounds = summary.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    return {
      summaryBottom: summaryBounds.bottom,
      menuTop: menuBounds.top,
      menuLeft: menuBounds.left,
      menuRight: menuBounds.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuBottom: menuBounds.bottom,
    };
  });

  expect(geometry.menuTop).toBeGreaterThanOrEqual(geometry.summaryBottom);
  expect(geometry.menuLeft).toBeGreaterThanOrEqual(8);
  expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth - 8);
  expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
  await expect(page.getByLabel("Markdown box opacity")).toBeVisible();
});

test("opens the full guide in a new tab from settings", async ({ page }) => {
  await page.goto("/");
  await page.locator(".section-settings > summary").click();

  const guide = page.getByRole("link", { name: "Guide", exact: true });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("target", "_blank");
  await expect(page.locator(".settings-guide-link")).toHaveCount(1);
  await expect(guide).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(guide).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await guide.hover();
  await expect(guide).toHaveCSS("border-top-color", "rgb(101, 80, 185)");
  await expect(guide).toHaveCSS("background-color", "rgb(238, 233, 247)");

  const guidePagePromise = page.waitForEvent("popup");
  await guide.click();
  const guidePage = await guidePagePromise;
  try {
    await guidePage.waitForLoadState("domcontentloaded");
    await expect(guidePage).toHaveTitle("SquillPad — Guide");
    await expect(
      guidePage.getByRole("heading", {
        name: "Keep words, sketches, and teamwork in one place.",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await guidePage.close();
  }

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator(".section-settings > summary").click();
  const darkSettingsGlassStyle = await page
    .locator(".section-settings__menu")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { backdropFilter: style.backdropFilter, backgroundImage: style.backgroundImage };
    });
  expect(darkSettingsGlassStyle.backdropFilter).toContain("blur");
  expect(darkSettingsGlassStyle.backgroundImage).toContain("linear-gradient");
  const darkGuide = page.getByRole("link", { name: "Guide", exact: true });
  await darkGuide.hover();
  await expect(darkGuide).toHaveCSS("border-top-color", "rgb(159, 197, 177)");
  await expect(darkGuide).toHaveCSS("background-color", "rgb(40, 53, 47)");
});

test("keeps canvas tool icons and code highlighting theme-aware", async ({ page }) => {
  await page.goto("/");
  const canvas = await openFreshPage(page);
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");

  const selectIcon = page.getByRole("button", { name: "Select", exact: true }).locator("svg path");
  const lightSelectColors = await selectIcon.evaluate((element) => {
    const path = element as SVGPathElement;
    return {
      fill: getComputedStyle(path).fill,
      buttonColor: getComputedStyle(path.parentElement!).color,
    };
  });
  expect(lightSelectColors.fill).toBe(lightSelectColors.buttonColor);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 160, bounds.y + 120);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.insertText("```ts\nconst value = 1;\n```");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const code = page.locator(".markdown-content pre code.hljs");
  await expect(code).toBeVisible();
  await expect(code.locator(".hljs-keyword")).toHaveText("const");
  const lightCodeColors = await code.evaluate((element) => ({
    code: getComputedStyle(element).color,
    keyword: getComputedStyle(element.querySelector(".hljs-keyword")!).color,
  }));
  expect(lightCodeColors.keyword).not.toBe(lightCodeColors.code);

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkSelectColors = await selectIcon.evaluate((element) => {
    const path = element as SVGPathElement;
    return {
      fill: getComputedStyle(path).fill,
      buttonColor: getComputedStyle(path.parentElement!).color,
    };
  });
  expect(darkSelectColors.fill).toBe(darkSelectColors.buttonColor);
  const darkCodeColors = await code.evaluate((element) => ({
    code: getComputedStyle(element).color,
    keyword: getComputedStyle(element.querySelector(".hljs-keyword")!).color,
  }));
  expect(darkCodeColors.keyword).not.toBe(darkCodeColors.code);
});

test("styles Page menu actions like Shapes menu options", async ({ page }) => {
  await page.goto("/");
  await openFreshPage(page);

  const trigger = page.locator(".page-heading .canvas-export-menu > summary");
  const menu = page.locator(".canvas-export-menu__content");
  const importButton = menu.getByRole("button", { name: "Import Markdown", exact: true });
  const exportRegion = menu.getByRole("combobox", { name: "Export region", exact: true });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText("Page");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(importButton).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(importButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await importButton.hover();
  await expect(importButton).toHaveCSS("border-top-color", "rgb(101, 80, 185)");
  await expect(importButton).toHaveCSS("background-color", "rgb(238, 233, 247)");

  await expect(exportRegion).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await exportRegion.hover();
  await expect(exportRegion).toHaveCSS("border-top-color", "rgb(101, 80, 185)");
  await exportRegion.click();
  await expect(menu).toBeVisible();

  await trigger.click();
  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(importButton).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(importButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await importButton.hover();
  await expect(importButton).toHaveCSS("border-top-color", "rgb(159, 197, 177)");
  await expect(importButton).toHaveCSS("background-color", "rgb(40, 53, 47)");

  await expect(exportRegion).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await exportRegion.hover();
  await expect(exportRegion).toHaveCSS("border-top-color", "rgb(159, 197, 177)");
  await exportRegion.click();
  await expect(menu).toBeVisible();
});

test("exposes the profile-level arrow-key pan speed setting", async ({ page }) => {
  await page.goto("/");
  await openFreshPage(page);

  await page.locator(".section-settings > summary").click();
  const speed = page.getByRole("slider", { name: "Arrow key panning speed", exact: true });
  const control = page.locator(".settings-range-control").filter({ has: speed });
  await expect(speed).toHaveAttribute("min", "0.25");
  await expect(speed).toHaveAttribute("max", "4");
  await expect(speed).toHaveAttribute("step", "0.25");
  await expect(speed).toHaveValue("1");
  await expect(control.locator("output")).toHaveText("1×");

  await speed.press("ArrowRight");
  await expect(speed).toHaveValue("1.25");
  await expect(control.locator("output")).toHaveText("1.25×");

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await page.locator(".section-settings > summary").click();
  await expect(speed).toBeVisible();
  expect(await speed.evaluate((element) => getComputedStyle(element).accentColor)).not.toBe("auto");
});

test("reorders navigation and uses hierarchy context actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();

  const pageItems = page.locator(".page-list > li[data-reorder-id]");
  const newPage = page.getByRole("button", { name: "New page", exact: true });
  await expect(newPage).toBeEnabled();
  let pageCount = await pageItems.count();
  while (pageCount < 2) {
    await newPage.click();
    pageCount += 1;
    await expect(pageItems).toHaveCount(pageCount);
  }

  const beforePageIds = await pageItems.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-reorder-id")),
  );
  await expect(page.locator(".reorder-handle")).toHaveCount(0);
  const sourceBounds = await pageItems.nth(1).locator(".page-select").boundingBox();
  const targetBounds = await pageItems.nth(0).locator(".page-select").boundingBox();
  if (sourceBounds === null || targetBounds === null) {
    throw new Error("Navigation reorder bounds are unavailable");
  }
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + 2, {
    steps: 8,
  });
  await expect(page.locator(".page-list > .reorder-drop-indicator")).toBeVisible();
  await page.screenshot({ path: "test-results/navigation-reorder-indicator.png" });
  await page.mouse.up();
  await expect
    .poll(() =>
      pageItems.evaluateAll((items) => items.map((item) => item.getAttribute("data-reorder-id"))),
    )
    .toEqual([beforePageIds[1], beforePageIds[0], ...beforePageIds.slice(2)]);

  const pageMenu = page.getByRole("menu", { name: /page actions$/u });
  await pageItems.first().locator(".hierarchy-context-trigger").click();
  await expect(pageMenu).toBeVisible();
  await expect(pageMenu).toHaveAttribute("data-context-menu-phase", "open");
  await expect(
    pageMenu.getByRole("menuitem", { name: "Add page below", exact: true }),
  ).toBeEnabled();
  await expect(pageMenu.getByRole("menuitem", { name: "Copy page", exact: true })).toBeEnabled();
  await expect(
    pageMenu.getByRole("menuitem", { name: "Paste page below", exact: true }),
  ).toBeDisabled();
  await expect(
    pageMenu.getByRole("menuitem", { name: "Duplicate page", exact: true }),
  ).toBeEnabled();
  await expect(pageMenu.getByRole("menuitem", { name: "Delete page", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/navigation-context-light.png" });
  await pageMenu.getByRole("menuitem", { name: "Copy page", exact: true }).click();
  await expect(pageMenu).toHaveCount(0);

  await pageItems.first().locator(".page-select").click({ button: "right" });
  await expect(pageMenu).toBeVisible();
  await expect(
    pageMenu.getByRole("menuitem", { name: "Paste page below", exact: true }),
  ).toBeEnabled();
  const pagesBeforePaste = await pageItems.count();
  await pageMenu.getByRole("menuitem", { name: "Paste page below", exact: true }).click();
  await expect(pageItems).toHaveCount(pagesBeforePaste + 1);

  const confirmation = page.locator(".confirmation-overlay");
  await pageItems.nth(1).locator(".page-select").click({ button: "right" });
  await pageMenu.getByRole("menuitem", { name: "Delete page", exact: true }).click();
  await expect(confirmation).toBeVisible();
  await expect(pageMenu).toHaveCount(0);
  await expect(confirmation.locator(".confirmation-dialog")).toHaveAttribute(
    "data-confirmation-phase",
    "open",
  );
  const confirmationBounds = await confirmation.locator(".confirmation-dialog").boundingBox();
  const viewport = page.viewportSize();
  if (confirmationBounds === null || viewport === null) {
    throw new Error("Confirmation dialog geometry is unavailable");
  }
  expect(
    Math.abs(confirmationBounds.x + confirmationBounds.width / 2 - viewport.width / 2),
  ).toBeLessThan(2);
  expect(
    Math.abs(confirmationBounds.y + confirmationBounds.height / 2 - viewport.height / 2),
  ).toBeLessThan(2);
  await page.screenshot({ path: "test-results/page-delete-confirmation.png" });
  await confirmation.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(pageItems).toHaveCount(pagesBeforePaste);

  const sectionItems = page
    .getByRole("navigation", { name: "Sections" })
    .locator("li[data-reorder-id]");
  const sectionMenu = page.getByRole("menu", { name: /section actions$/u });
  await sectionItems.first().locator(".hierarchy-context-trigger").click();
  await expect(sectionMenu).toBeVisible();
  await expect(sectionMenu).toHaveAttribute("data-context-menu-phase", "open");
  await expect(
    sectionMenu.getByRole("menuitem", { name: "Add section below", exact: true }),
  ).toBeEnabled();
  await expect(
    sectionMenu.getByRole("menuitem", { name: "Copy section", exact: true }),
  ).toBeEnabled();
  await expect(
    sectionMenu.getByRole("menuitem", { name: "Paste section below", exact: true }),
  ).toBeDisabled();
  await expect(
    sectionMenu.getByRole("menuitem", { name: "Duplicate section", exact: true }),
  ).toBeEnabled();
  await expect(
    sectionMenu.getByRole("menuitem", { name: "Delete section", exact: true }),
  ).toBeEnabled();
  const sectionColor = sectionMenu.getByLabel("Section color", { exact: true });
  await expect(sectionColor).toHaveValue("#7656b3");
  await sectionColor.fill("#ef4444");
  await expect
    .poll(async () => sectionItems.first().locator(".section-bookmark").evaluate((icon) => getComputedStyle(icon).color))
    .toBe("rgb(239, 68, 68)");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch("/api/hierarchy");
        const hierarchy = (await response.json()) as {
          sections: readonly { manifest: { metadata: Record<string, unknown> } }[];
        };
        return hierarchy.sections[0]?.manifest.metadata["squillpad:section-color"] ?? null;
      }),
    )
    .toBe("#ef4444");
  await page.screenshot({ path: "test-results/navigation-section-color-light.png" });
  await sectionMenu.getByRole("menuitem", { name: "Use theme color", exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch("/api/hierarchy");
        const hierarchy = (await response.json()) as {
          sections: readonly { manifest: { metadata: Record<string, unknown> } }[];
        };
        return hierarchy.sections[0]?.manifest.metadata["squillpad:section-color"] ?? null;
      }),
    )
    .toBe(null);
  await expect(sectionItems.first().locator(".section-bookmark")).not.toHaveCSS(
    "color",
    "rgb(239, 68, 68)",
  );
  await page.keyboard.press("Escape");
  await expect(sectionMenu).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await sectionItems.first().locator(".section-select").click({ button: "right" });
  await expect(sectionMenu).toBeVisible();
  await expect(sectionMenu).toHaveAttribute("data-context-menu-phase", "open");
  await page.screenshot({ path: "test-results/navigation-context-dark.png" });
});

test("moves pages from page actions and by dragging onto a section", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();

  const sectionItems = page
    .getByRole("navigation", { name: "Sections" })
    .locator("li[data-reorder-id]");
  const pageItems = page.locator(".page-list > li[data-reorder-id]");
  const sourceSection = sectionItems.first();
  const sourceSectionId = await sourceSection.getAttribute("data-reorder-id");
  const sourcePage = pageItems.first();
  const sourcePageId = await sourcePage.getAttribute("data-reorder-id");
  if (sourceSectionId === null || sourcePageId === null) {
    throw new Error("Initial navigation identities are unavailable");
  }

  await page.getByRole("button", { name: "New section", exact: true }).click();
  await expect(sectionItems).toHaveCount(2);
  const targetSection = sectionItems.nth(1);
  const targetSectionId = await targetSection.getAttribute("data-reorder-id");
  if (targetSectionId === null) throw new Error("Target section identity is unavailable");

  await sourceSection.locator(".section-select").click();
  await expect(sourceSection).toHaveClass(/is-active/);
  expect(await pageItems.count()).toBeGreaterThan(0);
  await expect(page.locator(".page-sidebar__footer")).toHaveCount(0);
  const expectDotsToTouchRow = async (row: Locator) => {
    const rowBounds = await row.boundingBox();
    const dotsBounds = await row.locator(".hierarchy-context-trigger").boundingBox();
    if (rowBounds === null || dotsBounds === null) {
      throw new Error("Navigation row geometry is unavailable");
    }
    expect(dotsBounds.x + dotsBounds.width).toBeCloseTo(rowBounds.x + rowBounds.width, 4);
    expect(await row.evaluate((element) => getComputedStyle(element).borderRadius)).toBe(
      await row
        .locator(".hierarchy-context-trigger")
        .evaluate((element) => getComputedStyle(element).borderRadius),
    );
  };
  await expectDotsToTouchRow(sourceSection);
  await targetSection.hover();
  await expectDotsToTouchRow(targetSection);

  await pageItems.first().locator(".hierarchy-context-trigger").click();
  const pageMenu = page.getByRole("menu", { name: /page actions$/u });
  const moveTrigger = pageMenu.getByRole("menuitem", {
    name: "Move page to section",
    exact: true,
  });
  await expect(moveTrigger).toBeEnabled();
  await moveTrigger.focus();
  const moveMenu = page.getByRole("menu", { name: "Move page to section", exact: true });
  await expect(moveMenu).toBeVisible();
  await moveTrigger.press("ArrowRight");
  await expect(moveMenu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(moveTrigger).toBeFocused();
  await moveTrigger.hover();
  await expect(moveMenu).toBeVisible();
  await expect(moveMenu).toHaveAttribute("data-page-move-menu-phase", "open");
  await expect(moveMenu).toHaveAttribute("data-page-move-menu-side", "right");
  const targetMoveItem = moveMenu.locator(`[data-section-id="${targetSectionId}"]`);
  await expect(targetMoveItem).toBeVisible();
  await pageMenu.getByRole("menuitem", { name: "Copy page", exact: true }).hover();
  await expect(moveMenu).toHaveCount(0);
  await moveTrigger.hover();
  await expect(moveMenu).toHaveAttribute("data-page-move-menu-phase", "open");
  await page.screenshot({ path: "test-results/navigation-page-move-light.png" });
  await targetMoveItem.click();

  await expect(pageMenu).toHaveCount(0);
  await expect(targetSection).toHaveClass(/is-active/);
  await expect(page.locator(`.page-list > li[data-reorder-id="${sourcePageId}"]`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/sections/${targetSectionId}/pages/${sourcePageId}$`));
  const targetPageCountBeforeDrag = await pageItems.count();

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await sourceSection.locator(".section-select").click();
  const sourcePageCountBeforeCreate = await pageItems.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pageItems).toHaveCount(sourcePageCountBeforeCreate + 1);
  const draggedPage = pageItems.last();
  const draggedPageId = await draggedPage.getAttribute("data-reorder-id");
  await draggedPage.locator(".hierarchy-context-trigger").click();
  const darkPageMenu = page.getByRole("menu", { name: /page actions$/u });
  await darkPageMenu.getByRole("menuitem", { name: "Move page to section", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "Move page to section", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/navigation-page-move-dark.png" });
  await page.keyboard.press("Escape");
  await expect(darkPageMenu).toHaveCount(0);
  await page.setViewportSize({ width: 800, height: 900 });
  await draggedPage.locator(".hierarchy-context-trigger").click();
  const narrowPageMenu = page.getByRole("menu", { name: /page actions$/u });
  await narrowPageMenu.getByRole("menuitem", { name: "Move page to section", exact: true }).hover();
  const narrowMoveMenu = page.getByRole("menu", { name: "Move page to section", exact: true });
  await expect(narrowMoveMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(narrowPageMenu).toHaveCount(0);
  const draggedPageBounds = await draggedPage.locator(".page-select").boundingBox();
  const targetSectionBounds = await targetSection.boundingBox();
  if (draggedPageBounds === null || targetSectionBounds === null) {
    throw new Error("Cross-section drag geometry is unavailable");
  }
  await page.mouse.move(
    draggedPageBounds.x + draggedPageBounds.width / 2,
    draggedPageBounds.y + draggedPageBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetSectionBounds.x + targetSectionBounds.width / 2,
    targetSectionBounds.y + targetSectionBounds.height / 2,
    { steps: 12 },
  );
  await expect(targetSection).toHaveClass(/is-page-drop-target/);
  await page.mouse.up();

  await expect(targetSection).toHaveClass(/is-active/);
  if (draggedPageId === null) throw new Error("Dragged page identity is unavailable");
  await expect(page.locator(`.page-list > li[data-reorder-id="${draggedPageId}"]`)).toBeVisible();
  await expect(page.locator(".page-list > li[data-reorder-id]")).toHaveCount(
    targetPageCountBeforeDrag + 1,
  );
});

test("standardizes navigation creation controls and resizes both panels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();

  const sections = page.getByRole("navigation", { name: "Sections" });
  const pages = page.locator(".page-sidebar");
  await expect(sections.getByRole("button", { name: "New section", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Delete section", exact: true })).toHaveCount(0);

  const sectionPanel = sections;
  const pagePanel = pages;
  const sectionHandle = page.getByRole("separator", { name: "Resize sections panel" });
  const pageHandle = page.getByRole("separator", { name: "Resize pages panel" });
  const sectionBefore = await sectionPanel.boundingBox();
  const pageBefore = await pagePanel.boundingBox();
  const sectionHandleBounds = await sectionHandle.boundingBox();
  if (sectionBefore === null || pageBefore === null || sectionHandleBounds === null) {
    throw new Error("Navigation resize geometry is unavailable");
  }

  await page.mouse.move(
    sectionHandleBounds.x + sectionHandleBounds.width / 2,
    sectionHandleBounds.y + sectionHandleBounds.height / 2,
  );
  await page.mouse.down();
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        section: getComputedStyle(document.querySelector(".is-section-resize")!, "::after").opacity,
        page: getComputedStyle(document.querySelector(".is-page-resize")!, "::after").opacity,
      })),
    )
    .toEqual({ section: "1", page: "0.35" });
  await page.mouse.move(
    sectionHandleBounds.x + sectionHandleBounds.width / 2 + 80,
    sectionHandleBounds.y + sectionHandleBounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await sectionPanel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(sectionBefore.width + 70);
  await expect
    .poll(async () => (await pagePanel.boundingBox())?.x ?? 0)
    .toBeGreaterThan(pageBefore.x + 70);

  const pageHandleBounds = await pageHandle.boundingBox();
  if (pageHandleBounds === null) throw new Error("Pages resize geometry is unavailable");
  const pageWidthBeforeResize = (await pagePanel.boundingBox())?.width ?? 0;
  await page.mouse.move(
    pageHandleBounds.x + pageHandleBounds.width / 2,
    pageHandleBounds.y + pageHandleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    pageHandleBounds.x + pageHandleBounds.width / 2 + 80,
    pageHandleBounds.y + pageHandleBounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await pagePanel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(pageWidthBeforeResize + 70);

  await sectionHandle.focus();
  const sectionWidthBeforeKeyboardResize = (await sectionPanel.boundingBox())?.width ?? 0;
  await sectionHandle.press("ArrowLeft");
  await expect
    .poll(async () => (await sectionPanel.boundingBox())?.width ?? 0)
    .toBeLessThan(sectionWidthBeforeKeyboardResize - 10);

  await page.setViewportSize({ width: 800, height: 900 });
  await expect(sectionHandle).toBeHidden();
  await expect(pageHandle).toBeHidden();
  await expect(sections.getByRole("button", { name: "New section", exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  const pageMenu = page.getByRole("menu", { name: /page actions$/u });
  await pages.locator(".page-list > li").first().locator(".hierarchy-context-trigger").click();
  await expect(pageMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pageMenu).toHaveCount(0);
});
