import { expect, test, type Locator, type Page } from "@playwright/test";

test.setTimeout(60_000);

async function drag(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function createPage(page: Page): Promise<Locator> {
  const pages = page.locator(".page-list > li > .page-select");
  await expect(pages.first()).toBeVisible();
  const count = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(count + 1);
  await pages.last().click();
  return page.getByLabel("Infinite page canvas");
}

test("keeps a live, movable, proportional reference view across page navigation", async ({
  page,
}) => {
  await page.goto("/");
  const sourceCanvas = await createPage(page);
  const sourceCanvasBounds = await sourceCanvas.boundingBox();
  if (sourceCanvasBounds === null) throw new Error("Source canvas bounds are unavailable");

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(sourceCanvasBounds.x + 170, sourceCanvasBounds.y + 150);
  await page.keyboard.insertText("PiP live reference");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  const sourceMarkdown = sourceCanvas.locator(".canvas-element.kind-markdown");
  const sourceBounds = await sourceMarkdown.boundingBox();
  if (sourceBounds === null) throw new Error("Source element bounds are unavailable");

  await page.getByLabel("Miscellaneous tools").click();
  const pictureInPictureTool = page.getByTitle(
    "Picture in picture: draw a region to keep a live, read-only reference view",
  );
  await expect(pictureInPictureTool).toHaveAttribute(
    "title",
    "Picture in picture: draw a region to keep a live, read-only reference view",
  );
  await pictureInPictureTool.click();
  await drag(
    page,
    { x: sourceBounds.x - 20, y: sourceBounds.y - 20 },
    { x: sourceBounds.x + sourceBounds.width + 20, y: sourceBounds.y + sourceBounds.height + 20 },
  );

  const pip = page.locator(".picture-in-picture-window");
  await expect(pip).toHaveCount(1);
  await expect(pip.locator(".canvas-status")).toHaveCount(0);
  const resizeIndicatorOpacity = () =>
    pip
      .getByRole("button", { name: /Resize picture-in-picture reference/u })
      .evaluate((element) => getComputedStyle(element, "::after").opacity);
  await page.mouse.move(20, 20);
  await expect.poll(resizeIndicatorOpacity).toBe("0");
  await pip.hover();
  await expect.poll(resizeIndicatorOpacity).toBe("0.45");
  await page.mouse.move(20, 20);
  await expect.poll(resizeIndicatorOpacity).toBe("0");
  expect(await pip.getAttribute("title")).toBeNull();
  await expect(pip).toContainText("PiP live reference");
  const initial = await pip.boundingBox();
  if (initial === null) throw new Error("PiP bounds are unavailable");
  expect(Math.abs(1600 - initial.x - initial.width)).toBeLessThanOrEqual(22);
  expect(Math.abs(1100 - initial.y - initial.height)).toBeLessThanOrEqual(22);

  await sourceMarkdown.dblclick();
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" updated");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(pip).toContainText("PiP live reference updated");

  await createPage(page);
  await expect(pip).toContainText("PiP live reference updated");

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(pip).toHaveCSS("background-color", "rgb(8, 9, 9)");
  const windowSurface = await pip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderWidth: style.borderWidth, boxShadow: style.boxShadow };
  });
  expect(windowSurface.borderWidth).toBe("0px");
  expect(windowSurface.boxShadow).not.toBe("none");

  const targetCanvas = page.getByLabel("Infinite page canvas");
  const targetBounds = await targetCanvas.boundingBox();
  if (targetBounds === null) throw new Error("Target canvas bounds are unavailable");
  await page.getByLabel("Miscellaneous tools").click();
  const miscellaneousPanel = page.locator(".canvas-miscellaneous-menu > [data-animated-menu]");
  await expect(miscellaneousPanel).toBeVisible();
  expect(
    await miscellaneousPanel.evaluate((element) => getComputedStyle(element).backdropFilter),
  ).not.toBe("none");
  await page.getByRole("button", { name: "Picture in picture", exact: true }).click();
  await drag(
    page,
    { x: targetBounds.x + 80, y: targetBounds.y + 80 },
    { x: targetBounds.x + 220, y: targetBounds.y + 180 },
  );
  await expect(pip).toHaveCount(2);
  const secondPip = pip.last();
  await secondPip.focus();
  await secondPip.getByRole("button", { name: /Close picture-in-picture reference/u }).click();
  await expect(pip).toHaveCount(1);

  const resize = pip.getByRole("button", { name: /Resize picture-in-picture reference/u });
  const resizeBounds = await resize.boundingBox();
  if (resizeBounds === null) throw new Error("Resize handle bounds are unavailable");
  await drag(
    page,
    { x: resizeBounds.x + resizeBounds.width / 2, y: resizeBounds.y + resizeBounds.height / 2 },
    {
      x: resizeBounds.x + resizeBounds.width / 2 + 80,
      y: resizeBounds.y + resizeBounds.height / 2 + 40,
    },
  );
  const resized = await pip.boundingBox();
  if (resized === null) throw new Error("Resized PiP bounds are unavailable");
  expect(resized.width / resized.height).toBeCloseTo(initial.width / initial.height, 2);

  await drag(
    page,
    { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 },
    { x: resized.x + resized.width / 2 - 140, y: resized.y + resized.height / 2 - 120 },
  );
  const moved = await pip.boundingBox();
  expect(moved?.x).toBeLessThan(resized.x - 100);
  expect(moved?.y).toBeLessThan(resized.y - 80);

  if (moved === null) throw new Error("Moved PiP bounds are unavailable");
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  const close = pip.getByRole("button", { name: /Close picture-in-picture reference/u });
  await expect(close).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(close).toHaveCSS("transition-duration", "0s");
  await close.click();
  await expect(pip).toHaveCount(0);
});
