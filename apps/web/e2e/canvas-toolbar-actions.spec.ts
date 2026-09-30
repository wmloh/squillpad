import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

for (const theme of ["light", "dark"] as const) {
  test(`supports shape thickness and animated opacity presets in ${theme} mode`, async ({
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
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    const pen = page.getByRole("slider", {
      name: "Ink thickness",
      exact: true,
    });
    const penRange = await pen.evaluate((input) => [
      input.getAttribute("min"),
      input.getAttribute("max"),
      input.getAttribute("step"),
    ]);
    await page.getByText("Shapes", { exact: true }).click();
    await page.getByTitle("Rectangle tool", { exact: true }).click();
    const thickness = page.getByRole("slider", {
      name: "Shape thickness",
      exact: true,
    });
    expect(
      await thickness.evaluate((input) => [
        input.getAttribute("min"),
        input.getAttribute("max"),
        input.getAttribute("step"),
      ]),
    ).toEqual(penRange);
    await thickness.focus();
    await thickness.press("End");
    await expect(thickness).toHaveValue("30");
    await expect(thickness.locator("+ output")).toHaveText("30px");

    const menu = page.locator(".canvas-opacity-menu");
    const trigger = page.getByLabel("Shape opacity", { exact: true });
    const options = page.getByRole("group", {
      name: "Shape opacity options",
      exact: true,
    });
    const assertOrigin = async () => {
      const error = await menu.evaluate((details) => {
        const summary = details
          .querySelector("summary")!
          .getBoundingClientRect();
        const panel = details.querySelector<HTMLElement>(
          "[data-animated-menu]",
        )!;
        const bounds = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        return Math.max(
          Math.abs(
            bounds.x +
              bounds.width / 2 +
              parseFloat(style.getPropertyValue("--menu-origin-x")) -
              summary.x -
              summary.width / 2,
          ),
          Math.abs(
            bounds.y +
              bounds.height / 2 +
              parseFloat(style.getPropertyValue("--menu-origin-y")) -
              summary.y -
              summary.height / 2,
          ),
        );
      });
      expect(error).toBeLessThan(1);
    };
    for (const percentage of [10, 25, 50, 100, 75]) {
      await trigger.click();
      await expect(menu).toHaveAttribute("data-menu-phase", "open");
      await expect(options.getByRole("button")).toHaveText([
        "10%",
        "25%",
        "50%",
        "75%",
        "100%",
      ]);
      await assertOrigin();
      await options
        .getByRole("button", { name: `${percentage}%`, exact: true })
        .click();
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(trigger).toHaveText(`Opacity ${percentage}%`);
      await expect(trigger).toBeFocused();
    }
    await trigger.press("Enter");
    await expect(menu).toHaveAttribute("data-menu-phase", "open");
    await expect(
      options.getByRole("button", { name: "75%", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await trigger.press("Tab");
    await expect(
      options.getByRole("button", { name: "10%", exact: true }),
    ).toBeFocused();
    expect(
      await page
        .locator(":focus-visible")
        .evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe("solid");
    await page.screenshot({
      path: testInfo.outputPath(`opacity-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    if (theme === "light")
      await expect(menu).toHaveAttribute("data-menu-phase", "closing");
    await expect(menu).not.toHaveAttribute("open", "");
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await expect(menu).toHaveAttribute("data-menu-phase", "open");
    await thickness.focus();
    await expect(menu).not.toHaveAttribute("open", "");
    await trigger.click();
    await expect(menu).toHaveAttribute("data-menu-phase", "open");
    await page.locator(".page-heading").click({ position: { x: 5, y: 5 } });
    await expect(menu).not.toHaveAttribute("open", "");

    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + 80, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 270, bounds.y + 175, { steps: 8 });
    await page.mouse.up();
    const route = new URL(page.url()).hash.split("/");
    const readShape = async () =>
      (
        await (
          await page.request.get(`/api/pages/${route[4]}/${route[6]}`)
        ).json()
      ).canvas[0];
    await expect
      .poll(async () => (await readShape())?.style)
      .toMatchObject({ strokeWidth: 30, opacity: 0.75 });
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page
      .locator("[data-canvas-element-id].kind-shape")
      .click({ position: { x: 25, y: 2 } });
    await thickness.focus();
    await thickness.press("Home");
    await expect(thickness).toHaveValue("2");
    await trigger.click();
    await options.getByRole("button", { name: "25%", exact: true }).click();
    await expect
      .poll(async () => (await readShape())?.style)
      .toMatchObject({ strokeWidth: 2, opacity: 0.25 });

    await trigger.click();
    await expect(menu).toHaveAttribute("data-menu-phase", "open");
    await page.setViewportSize({ width: 1100, height: 900 });
    await assertOrigin();
    await trigger.press("Escape");
    await expect(menu).not.toHaveAttribute("open", "");
    await page.setViewportSize({ width: 800, height: 700 });
    await page
      .getByRole("button", { name: "Enter fullscreen", exact: true })
      .click();
    await expect(page.locator(".canvas-toolbar.is-fullscreen")).toBeVisible();
    await trigger.click();
    await expect(menu).toHaveAttribute("data-menu-phase", "open");
    await assertOrigin();
    await trigger.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const panel = (await options.boundingBox())!;
        return panel.x >= 0 && panel.x + panel.width <= 800;
      })
      .toBe(true);
    await assertOrigin();
    await options.getByRole("button", { name: "50%", exact: true }).hover();
    await page.screenshot({
      path: testInfo.outputPath(`opacity-fullscreen-${theme}.png`),
    });
    await options.getByRole("button", { name: "50%", exact: true }).click();
    await expect(menu).not.toHaveAttribute("open", "");
    await expect.poll(async () => (await readShape())?.style.opacity).toBe(0.5);
  });

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
