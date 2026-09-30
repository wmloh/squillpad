import { expect, test, type Page } from "@playwright/test";

async function stroke(page: Page, points: readonly (readonly [number, number])[]) {
  await page.mouse.move(...points[0]!);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 8 });
  await page.mouse.up();
}

for (const theme of ["light", "dark"] as const) {
  test(`selects nested ink through filled and selected shape interiors in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    if (theme === "dark") {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    await page.goto("/");
    const canvas = page.getByLabel("Infinite page canvas", { exact: true });
    await expect(canvas).toBeVisible();
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page.getByRole("button", { name: `Switch to ${theme} mode` }).click();
    }
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.locator(".page-list > li > .page-select").last().click();
    await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
    const b = (await canvas.boundingBox())!;
    let x = b.x + 180;
    let y = b.y + 180;
    await page.getByText("Shapes", { exact: true }).click();
    await page.getByTitle("Rectangle tool", { exact: true }).click();
    await stroke(page, [
      [x, y],
      [x + 300, y + 240],
    ]);
    const shape = page.locator(".canvas-element.kind-shape");
    await expect(shape).toHaveCount(1);
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    const penShapeBounds = (await shape.boundingBox())!;
    x = penShapeBounds.x;
    y = penShapeBounds.y;
    await stroke(page, [
      [x + 70, y + 70],
      [x + 170, y + 70],
      [x + 170, y + 150],
    ]);
    const ink = page.locator(".canvas-element.kind-ink");
    await expect(ink).toHaveCount(1);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const selectShapeBounds = (await shape.boundingBox())!;
    x = selectShapeBounds.x;
    y = selectShapeBounds.y;
    await page.mouse.click(x + 150, y + 1);
    await expect(shape).toHaveClass(/is-selected/);
    await page.getByRole("checkbox", { name: "Fill", exact: true }).check();
    await page.getByTitle("Bring to front", { exact: true }).click();
    const shapeStyle = await shape.getAttribute("style");
    const clickInside = async (dx: number, dy: number) => {
      const box = (await shape.boundingBox())!;
      await page.mouse.click(box.x + dx, box.y + dy);
    };
    const strokeInside = async (offsets: readonly (readonly [number, number])[]) => {
      const box = (await shape.boundingBox())!;
      await stroke(
        page,
        offsets.map(([dx, dy]) => [box.x + dx, box.y + dy] as const),
      );
    };

    // Even a selected, filled shape above the ink must pass interior hits through.
    await clickInside(115, 71);
    await expect(ink).toHaveClass(/is-selected/);
    await expect(shape).not.toHaveClass(/is-selected/);
    const hoverBox = (await shape.boundingBox())!;
    await page.mouse.move(hoverBox.x + 110, hoverBox.y + 120);
    await expect(page.locator(".canvas-element.is-hovered")).toHaveCount(0);
    await clickInside(110, 120);
    await expect(page.locator(".canvas-element.is-selected")).toHaveCount(0);
      await clickInside(150, 1);
      await expect(shape).toHaveClass(/is-selected/);

    // Starting a lasso inside both bounding boxes must not begin an element drag.
    await strokeInside([
      [100, 120],
      [50, 160],
      [190, 160],
      [190, 50],
      [50, 50],
      [100, 120],
    ]);
    await expect(ink).toHaveClass(/is-selected/);
    await expect(shape).not.toHaveClass(/is-selected/);
    const inkStyle = await ink.getAttribute("style");
    await strokeInside([
      [115, 71],
      [135, 91],
    ]);
    expect(await ink.getAttribute("style")).not.toBe(inkStyle);
    expect(await shape.getAttribute("style")).toBe(shapeStyle);
    await canvas.focus();
    await page.keyboard.press("Control+z");
    expect(await ink.getAttribute("style")).toBe(inkStyle);

    // Tolerance stays four screen pixels even after zooming out.
    const beforeZoom = (await shape.boundingBox())!;
    await page.mouse.move(beforeZoom.x + 150, beforeZoom.y + 120);
    await page.mouse.wheel(0, 460);
    await expect(page.getByLabel("Zoom level")).not.toHaveText("100%");
    const zoomed = (await shape.boundingBox())!;
    await page.mouse.click(zoomed.x + zoomed.width / 2, zoomed.y - 3);
    await expect(shape).toHaveClass(/is-selected/);
    const afterSelect = (await shape.boundingBox())!;
    await page.mouse.click(afterSelect.x + afterSelect.width / 2, afterSelect.y - 7);
    await expect(shape).not.toHaveClass(/is-selected/);
    const afterDeselect = (await shape.boundingBox())!;
    await page.mouse.move(afterDeselect.x + afterDeselect.width / 2, afterDeselect.y + 1);
    await expect(shape).toHaveClass(/is-hovered/);
    await page.screenshot({
      path: testInfo.outputPath(`edge-selection-${theme}.png`),
    });
    expect(errors).toEqual([]);
  });
}
