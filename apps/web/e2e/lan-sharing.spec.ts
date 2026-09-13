import { expect, test } from "@playwright/test";

test("configures the host-only client limit from the Sharing panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Infinite page canvas")).toBeVisible();

  const sharingSummary = page.locator(".lan-sharing > summary");
  await expect(sharingSummary).toBeVisible();
  await sharingSummary.click();

  const limitInput = page.getByLabel("Maximum clients (including host)");
  await expect(limitInput).toHaveValue("5");
  await expect(limitInput).toHaveAttribute("min", "1");
  await expect(limitInput).toHaveAttribute("max", "20");
  await expect(page.getByText(/1 of 5 client slots in use, including this host\./)).toBeVisible();

  await limitInput.fill("6");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(limitInput).toHaveValue("6");
  await expect(page.getByText(/\d+ of 6 client slots in use, including this host\./)).toBeVisible();

  await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
  await expect(page.locator('.notebook-app[data-theme="dark"]')).toBeVisible();
  await sharingSummary.click();
  await expect(limitInput).toBeVisible();
  await expect(page.locator(".lan-sharing__content")).toBeVisible();

  await limitInput.fill("5");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(limitInput).toHaveValue("5");
});
