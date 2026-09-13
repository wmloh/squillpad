import { expect, test } from "@playwright/test";

test("scales app text while preserving world-space Markdown sizing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();

  const pages = page.locator(".page-list > li > .page-select");
  const pageCount = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(pageCount + 1);
  await pages.last().click();

  const canvas = page.getByLabel("Infinite page canvas");
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 160, bounds.y + 120);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.insertText("Scale boundary");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  const markdownContent = page.locator(".kind-markdown .markdown-content").last();
  await expect(markdownContent).toContainText("Scale boundary");
  await expect(page.locator(".topbar-status-group .topbar-status-control")).toHaveCount(3);

  const measure = () =>
    page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".canvas-toolbar");
      const markdown = document.querySelector<HTMLElement>(".markdown-content");
      const statusGroup = document.querySelector<HTMLElement>(".topbar-status-group");
      if (toolbar === null || markdown === null || statusGroup === null) {
        throw new Error("Rendered text is unavailable");
      }
      const groupBounds = statusGroup.getBoundingClientRect();
      return {
        body: Number.parseFloat(getComputedStyle(document.body).fontSize),
        toolbar: Number.parseFloat(getComputedStyle(toolbar).fontSize),
        markdown: Number.parseFloat(getComputedStyle(markdown).fontSize),
        scale: document.documentElement.style.getPropertyValue("--app-text-scale"),
        statuses: [...statusGroup.querySelectorAll<HTMLElement>(".topbar-status-control")].map(
          (status) => {
            const bounds = status.getBoundingClientRect();
            return {
              text: status.textContent?.trim(),
              fontSize: Number.parseFloat(getComputedStyle(status).fontSize),
              centerOffset:
                (bounds.top + bounds.bottom) / 2 - (groupBounds.top + groupBounds.bottom) / 2,
            };
          },
        ),
      };
    });

  const initial = await measure();
  expect(initial.body).toBeCloseTo(16, 1);
  expect(initial.toolbar).toBeCloseTo(12.8, 1);
  expect(initial.markdown).toBeCloseTo(16, 1);
  expect(initial.statuses.map(({ fontSize }) => fontSize)).toEqual(
    initial.statuses.map(() => 12.48),
  );
  expect(initial.statuses.every(({ centerOffset }) => Math.abs(centerOffset) < 0.5)).toBe(true);

  await page.locator(".topbar-settings > summary").click();
  const slider = page.getByLabel("App text scale");
  await expect(slider).toHaveAttribute("min", "80");
  await expect(slider).toHaveAttribute("max", "120");
  await expect(slider).toHaveValue("100");
  await slider.fill("120");
  await expect.poll(measure).toMatchObject({ scale: "1.2" });
  const scaled = await measure();
  expect(scaled.body).toBeCloseTo(19.2, 1);
  expect(scaled.toolbar).toBeCloseTo(15.36, 1);
  expect(scaled.markdown).toBeCloseTo(16, 1);
  expect(scaled.statuses.map(({ fontSize }) => fontSize)).toEqual(
    scaled.statuses.map(() => 14.976),
  );
  expect(scaled.statuses.every(({ centerOffset }) => Math.abs(centerOffset) < 0.5)).toBe(true);

  await page.reload();
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  await expect.poll(measure).toMatchObject({ scale: "1.2" });

  await page.locator(".topbar-settings > summary").click();
  await page.getByLabel("App text scale").fill("100");
  await page.locator(".topbar-settings > summary").click();
  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator('.notebook-app[data-theme="dark"]')).toBeVisible();
  await page.screenshot({ animations: "disabled" });
});
