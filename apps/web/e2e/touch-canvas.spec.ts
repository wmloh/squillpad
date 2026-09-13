import { expect, test, type Page } from "@playwright/test";

const DRAWING_PREFERENCES_KEY = "squillpad:drawing-preferences:v1";

async function openFreshPage(page: Page) {
  const pages = page.locator(".page-list > li > .page-select");
  await expect(page.getByRole("button", { name: "New page", exact: true })).toBeVisible();
  const count = await pages.count();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(pages).toHaveCount(count + 1);
  await pages.last().click();
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();
  return page.getByLabel("Infinite page canvas");
}

async function touchStroke(page: Page, x: number, y: number, dx: number, dy: number) {
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x, y }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 1, x: x + dx / 2, y: y + dy / 2 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 1, x: x + dx, y: y + dy }],
  });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

test("draws with touch in fullscreen when touch navigation is disabled", async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, JSON.stringify({ penDrawsTouchNavigates: false }));
  }, DRAWING_PREFERENCES_KEY);
  await page.goto("/");
  const canvas = await openFreshPage(page);
  await page.getByRole("button", { name: "Pen", exact: true }).click();

  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");
  await touchStroke(page, bounds.x + 180, bounds.y + 160, 100, 40);
  await expect(page.locator(".kind-ink")).toHaveCount(1);

  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).tap();
  await expect(page.locator(".notebook-app.is-canvas-fullscreen")).toBeVisible();
  await page.getByRole("button", { name: "Hand", exact: true }).tap();
  await page.getByRole("button", { name: "Pen", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await canvas.evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");

  const fullscreenBounds = await canvas.boundingBox();
  if (fullscreenBounds === null) throw new Error("Fullscreen canvas bounds are unavailable");
  await touchStroke(page, fullscreenBounds.x + 320, fullscreenBounds.y + 260, 100, 40);
  await expect(page.locator(".kind-ink")).toHaveCount(2);
});
