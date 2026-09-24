import { expect, test } from "@playwright/test";

test("keeps a customized Markdown editor fixed to the visible canvas after pan and zoom", async ({ page }) => {
  await page.goto("/");
  const pages = page.locator(".page-list > li > .page-select");
  await expect(pages.first()).toBeVisible();
  const initialCount = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(initialCount + 1);
  await pages.last().click();

  const canvas = page.getByLabel("Infinite page canvas");
  const surface = await canvas.boundingBox();
  if (surface === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(surface.x + 300, surface.y + 200);
  await page.keyboard.insertText(Array.from({ length: 35 }, (_, index) => `Line ${index + 1}`).join("\n\n"));
  const editor = page.locator(".markdown-editor-popover.is-open");
  await expect(editor).toBeVisible();
  const handle = page.getByRole("button", { name: "Move Markdown editor" });
  const handleBounds = await handle.boundingBox();
  if (handleBounds === null) throw new Error("Move handle bounds are unavailable");
  await page.mouse.move(handleBounds.x + 40, handleBounds.y + 16);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + 140, handleBounds.y + 76, { steps: 8 });
  await page.mouse.up();

  const geometry = () => canvas.evaluate((element) => {
    const overlay = element.parentElement?.querySelector<HTMLElement>(".canvas-screen-overlay");
    const editorElement = overlay?.querySelector<HTMLElement>(".markdown-editor-popover");
    const status = overlay?.querySelector<HTMLElement>(".canvas-status");
    if (editorElement === null || status === null) throw new Error("Canvas overlays are unavailable");
    const canvasRect = element.getBoundingClientRect();
    const editorRect = editorElement.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    return {
      editorX: editorRect.left - canvasRect.left,
      editorY: editorRect.top - canvasRect.top,
      statusBottom: canvasRect.bottom - statusRect.bottom,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      width: editorRect.width,
      height: editorRect.height,
      surfaceWidth: canvasRect.width,
      surfaceHeight: canvasRect.height,
    };
  });
  const before = await geometry();
  const gridBefore = await canvas.evaluate((element) => element.style.backgroundPosition);
  await page.getByRole("button", { name: "Close Markdown editor" }).click();
  await expect(editor).toHaveCount(0);
  await page.keyboard.down("Space");
  await page.mouse.move(surface.x + 850, surface.y + 550);
  await page.mouse.down();
  await page.mouse.move(surface.x + 905, surface.y + 585, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await page.mouse.move(surface.x + 900, surface.y + 500);
  await page.mouse.wheel(0, -150);
  await expect(page.getByLabel("Zoom level")).not.toHaveText("100%");
  expect(await canvas.evaluate((element) => element.style.backgroundPosition)).not.toBe(gridBefore);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator(".canvas-element.kind-markdown").dblclick({ position: { x: 20, y: 20 } });
  await expect(editor).toBeVisible();
  const after = await geometry();
  expect(after.editorX).toBeCloseTo(before.editorX, 0);
  expect(after.editorY).toBeCloseTo(before.editorY, 0);
  expect(after.statusBottom).toBeCloseTo(before.statusBottom, 0);
  expect(after.scrollLeft).toBe(0);
  expect(after.scrollTop).toBe(0);
  expect(after.editorX).toBeGreaterThanOrEqual(0);
  expect(after.editorY).toBeGreaterThanOrEqual(0);
  expect(after.editorX + after.width).toBeLessThanOrEqual(after.surfaceWidth + 1);
  expect(after.editorY + after.height).toBeLessThanOrEqual(after.surfaceHeight + 1);
  const attemptedScroll = await canvas.evaluate((element) => {
    element.scrollTop = 120;
    element.scrollLeft = 120;
    return { top: element.scrollTop, left: element.scrollLeft };
  });
  expect(attemptedScroll.top).toBeGreaterThan(0);
  const scrolled = await geometry();
  expect(scrolled.editorX).toBeCloseTo(after.editorX, 0);
  expect(scrolled.editorY).toBeCloseTo(after.editorY, 0);
  expect(scrolled.statusBottom).toBeCloseTo(before.statusBottom, 0);
});
