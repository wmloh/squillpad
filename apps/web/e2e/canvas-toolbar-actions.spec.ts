import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

for (const theme of ["light", "dark"] as const) {
  test(`supports shape fill and touch deletion in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    if (theme === "dark") {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    await page.goto("/");
    const canvas = page.getByLabel("Infinite page canvas", { exact: true });
    await expect(canvas).toBeVisible();
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", { name: `Switch to ${theme} mode` })
        .click();
    }
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.locator(".page-list > li > .page-select").last().click();
    const objects = page.locator("[data-canvas-element-id]");
    await expect(objects).toHaveCount(0);
    const deleteButton = page.getByRole("button", {
      name: "Delete selected objects",
      exact: true,
    });
    await expect(deleteButton).toBeDisabled();
    await expect(
      page
        .getByRole("button", { name: "Paste objects", exact: true })
        .locator("+ button"),
    ).toHaveAttribute("aria-label", "Delete selected objects");

    const fill = page.getByRole("checkbox", { name: "Fill", exact: true });
    for (const [index, tool] of [
      "Line",
      "Arrow",
      "Rectangle",
      "Ellipse",
    ].entries()) {
      await page.getByText("Shapes", { exact: true }).click();
      await page.getByTitle(`${tool} tool`, { exact: true }).click();
      await expect(page.locator(".canvas-shape-menu")).not.toHaveAttribute(
        "open",
        "",
      );
      if (index < 2) {
        await expect(fill).toHaveCount(0);
      } else {
        await expect(fill).toBeVisible();
        await fill.uncheck();
        await fill.focus();
        await page.keyboard.press("Space");
        await expect(fill).toBeChecked();
        expect(
          await fill.evaluate((input) => {
            const track = input.nextElementSibling!;
            return getComputedStyle(track).outlineStyle;
          }),
        ).toBe("solid");
        await page.screenshot({
          path: testInfo.outputPath(`${tool.toLowerCase()}-${theme}.png`),
        });
      }
      const bounds = (await canvas.boundingBox())!;
      const x = bounds.x + 80;
      const y = bounds.y + 80 + index * 110;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 190, y + 75, { steps: 8 });
      await page.mouse.up();
      await expect(objects).toHaveCount(index + 1);
    }

    await page.getByRole("button", { name: "Select", exact: true }).click();
    for (const index of [0, 1]) {
      await objects.nth(index).click();
      await expect(objects.nth(index)).toHaveClass(/is-selected/);
      await expect(fill).toHaveCount(0);
    }
    await canvas.focus();
    await page.keyboard.press("Control+a");
    await expect(deleteButton).toBeEnabled();
    await fill.uncheck();
    await fill.check();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const route = new URL(page.url()).hash.split("/");
    const records = await (
      await page.request.get(`/api/pages/${route[4]}/${route[6]}`)
    ).json();
    for (const shape of records.canvas) {
      expect(shape.style.fillColor !== null).toBe(
        shape.geometry.kind === "rectangle" ||
          shape.geometry.kind === "ellipse",
      );
    }

    await deleteButton.tap();
    await expect(objects).toHaveCount(0);
    await expect(deleteButton).toBeDisabled();
    await page.getByRole("button", { name: "Undo", exact: true }).tap();
    await expect(objects).toHaveCount(4);
    await page.getByRole("button", { name: "Redo", exact: true }).tap();
    await expect(objects).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).tap();
    await expect(objects).toHaveCount(4);

    await page
      .getByRole("button", { name: "Enter fullscreen", exact: true })
      .click();
    await expect(page.locator(".canvas-toolbar.is-fullscreen")).toBeVisible();
    await canvas.focus();
    await page.keyboard.press("Control+a");
    await expect(deleteButton).toBeEnabled();
    await deleteButton.scrollIntoViewIfNeeded();
    await deleteButton.hover();
    await deleteButton.focus();
    await expect(deleteButton).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`fullscreen-${theme}.png`),
    });
    await deleteButton.tap();
    await expect(objects).toHaveCount(0);
    await expect(deleteButton).toBeDisabled();
  });
}
