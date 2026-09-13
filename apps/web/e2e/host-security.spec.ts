import { expect, test } from "@playwright/test";

test("authorized links register a persistent collaborator login", async ({ page, request }) => {
  expect((await request.get("http://127.0.0.1:4274/api/hierarchy")).status()).toBe(401);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Exercise canvas creation with the secure-context API unavailable.
  await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
  const token = "e".repeat(43);
  const sharing = await request.get("http://127.0.0.1:4274/api/sharing", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(sharing.status()).toBe(200);
  expect((await sharing.json()).connections[0].qr).toMatch(/^data:image\/png;base64,/);
  await page.goto("http://127.0.0.1:4274/#access_token=" + token);
  await expect(page.getByRole("heading", { name: "Sign in to this notebook" })).toBeVisible();
  await page.getByLabel("Username").fill("collaborator");
  await page.getByLabel("Password", { exact: true }).fill("x");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain(token);
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  const bounds = (await page.getByLabel("Infinite page canvas").boundingBox())!;
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 180, bounds.y + 140);
  await page.keyboard.insertText("Authenticated LAN note");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  await expect(
    page.locator(".kind-markdown").filter({ hasText: "Authenticated LAN note" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to this notebook" })).toBeVisible();
  await page.getByLabel("Username").fill("collaborator");
  await page.getByLabel("Password", { exact: true }).fill("x");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
