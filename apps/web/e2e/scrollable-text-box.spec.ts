import { expect, test } from "@playwright/test";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

for (const theme of ["light", "dark"] as const) {
  test(`shows text box scrollbars only on hover in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    if (theme === "dark") await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const pages = page.locator(".page-list > li > .page-select");
    await expect(pages.first()).toBeVisible();
    const pageCount = await pages.count();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await expect(pages).toHaveCount(pageCount + 1);
    await pages.last().click();
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", { name: `Switch to ${theme} mode` })
        .click();
    }

    const canvas = page.getByLabel("Infinite page canvas");
    const canvasBounds = await canvas.boundingBox();
    if (canvasBounds === null) throw new Error("Canvas bounds are unavailable");
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page.mouse.click(canvasBounds.x + 160, canvasBounds.y + 110);
    await page.keyboard.insertText(
      Array.from({ length: 14 }, (_, index) => `Paragraph ${index + 1}.`).join(
        "\n\n",
      ),
    );
    await page
      .getByRole("button", { name: "Close Markdown editor", exact: true })
      .click();

    const block = page.locator(".canvas-element.kind-markdown .markdown-block");
    await expect(block).toContainText("Paragraph 14.");
    await expect
      .poll(() =>
        block.evaluate(
          (element) => element.scrollHeight <= element.clientHeight,
        ),
      )
      .toBe(true);
    const unscrollableWidth = await block.evaluate(
      (element) => element.clientWidth,
    );
    await block.hover();
    expect(await block.evaluate((element) => element.clientWidth)).toBe(
      unscrollableWidth,
    );
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByLabel("Move Markdown block").click();
    const resize = page.getByLabel("Resize markdown element from bottom edge", {
      exact: true,
    });
    const resizeBounds = await resize.boundingBox();
    if (resizeBounds === null) throw new Error("Resize handle is unavailable");
    const resizeX = resizeBounds.x + resizeBounds.width / 2;
    const resizeY = resizeBounds.y + resizeBounds.height / 2;
    await page.mouse.move(resizeX, resizeY);
    await page.mouse.down();
    await page.mouse.move(resizeX, resizeY - 230, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        block.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    const zoom = page.getByLabel("Zoom level");
    const initialZoom = await zoom.textContent();
    const blockBounds = await block.boundingBox();
    if (blockBounds === null)
      throw new Error("Text box bounds are unavailable");
    await page.mouse.move(canvasBounds.x + 40, canvasBounds.y + 40);
    await expect(block).toHaveCSS(
      "scrollbar-color",
      "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)",
    );
    const contentWidth = await block.evaluate((element) => element.clientWidth);
    await page.screenshot({
      path: testInfo.outputPath(`scrollbar-hidden-${theme}.png`),
    });
    await page.mouse.move(blockBounds.x + 40, blockBounds.y + 40);
    await expect(block).toHaveCSS("scrollbar-color", "auto");
    expect(await block.evaluate((element) => element.clientWidth)).toBe(
      contentWidth,
    );
    await page.screenshot({
      path: testInfo.outputPath(`scrollbar-hover-${theme}.png`),
    });
    await page.mouse.wheel(0, 160);
    await expect
      .poll(() => block.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(zoom).toHaveText(initialZoom ?? "");

    await page.mouse.move(canvasBounds.x + 40, canvasBounds.y + 40);
    await expect(block).toHaveCSS(
      "scrollbar-color",
      "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)",
    );
    await expect
      .poll(() => block.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.mouse.wheel(0, 160);
    await expect(zoom).not.toHaveText(initialZoom ?? "");
  });
}
