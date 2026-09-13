import { expect, test, type Page } from "@playwright/test";

async function draw(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 20, { steps: 8 });
  await page.mouse.up();
}

test("two browser clients converge text, ink, and offline canvas edits", async ({ browser }) => {
  const leftContext = await browser.newContext();
  const rightContext = await browser.newContext();
  const left = await leftContext.newPage();
  const right = await rightContext.newPage();
  try {
    await Promise.all([left.goto("/"), right.goto("/")]);
    await Promise.all([
      expect(left.getByText("Synchronized", { exact: true })).toBeVisible(),
      expect(right.getByText("Synchronized", { exact: true })).toBeVisible(),
    ]);
    await left.getByRole("button", { name: "New page", exact: true }).click();
    await left.locator(".page-list > li > .page-select").last().click();
    await expect(left.getByText("Synchronized", { exact: true })).toBeVisible();
    await right.goto(left.url());
    await expect(right.getByText("Synchronized", { exact: true })).toBeVisible();
    const canvas = left.getByLabel("Infinite page canvas");
    const bounds = (await canvas.boundingBox())!;
    await left.getByRole("button", { name: "Text", exact: true }).click();
    await left.mouse.click(bounds.x + 180, bounds.y + 140);
    await left.keyboard.insertText("# Real-time source");
    await left.keyboard.press("Escape");
    const remoteMarkdown = right.locator(".kind-markdown").filter({ hasText: "Real-time source" });
    await expect(remoteMarkdown).toBeVisible();

    await left.getByRole("button", { name: "Pen", exact: true }).click();
    await draw(left, bounds.x + 190, bounds.y + 180);
    await expect(right.locator(".kind-ink")).toHaveCount(1);

    await rightContext.setOffline(true);
    await expect(right.getByText("Offline — editing locally", { exact: true })).toBeVisible();
    await remoteMarkdown.dblclick();
    await expect(right.locator(".markdown-editor-popover .cm-content")).toBeVisible();
    await right.keyboard.press("Control+a");
    await right.keyboard.insertText("# Offline source");
    await right.keyboard.press("Escape");
    await expect(
      left.locator(".kind-markdown").filter({ hasText: "Real-time source" }),
    ).toBeVisible();

    await rightContext.setOffline(false);
    await expect(right.getByText("Synchronized", { exact: true })).toBeVisible();
    await expect(
      left.locator(".kind-markdown").filter({ hasText: "Offline source" }),
    ).toBeVisible();

    expect((await left.request.get("http://127.0.0.1:4273/e2e/reopen")).ok()).toBe(true);
    await Promise.all([
      expect(left.getByText("Synchronized", { exact: true })).toBeVisible(),
      expect(right.getByText("Synchronized", { exact: true })).toBeVisible(),
    ]);
    await expect(left.locator(".kind-ink")).toHaveCount(1);
    await expect(
      right.locator(".kind-markdown").filter({ hasText: "Offline source" }),
    ).toBeVisible();
  } finally {
    await leftContext.close();
    await rightContext.close();
  }
});
