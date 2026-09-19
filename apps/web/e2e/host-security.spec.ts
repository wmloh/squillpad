import { expect, test } from "@playwright/test";

for (const mode of ["host", "invitation"] as const) {
  test(`${mode} links register a persistent collaborator login`, async ({ page, request }) => {
    expect((await request.get("http://127.0.0.1:4274/api/hierarchy")).status()).toBe(401);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Exercise canvas creation with the secure-context API unavailable.
    await page.addInitScript(() =>
      Object.defineProperty(crypto, "randomUUID", { value: undefined }),
    );
    const token = "e".repeat(43);
    const sharing = await request.get("http://127.0.0.1:4274/api/sharing", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sharing.status()).toBe(200);
    const connection = (await sharing.json()).connections[0];
    expect(connection.qr).toMatch(/^data:image\/png;base64,/);
    expect(connection.url).not.toContain(token);
    await page.goto(
      mode === "host" ? "http://127.0.0.1:4274/#access_token=" + token : connection.url,
    );
    await expect(page.getByRole("heading", { name: "Sign in to this notebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create profile" })).toBeDisabled();
    await page.screenshot({
      path: `../../.squillpad-runtime/auth-${mode}-light.png`,
    });
    await page.evaluate(() =>
      localStorage.setItem(
        "squillpad:application-preferences:v1",
        JSON.stringify({ theme: "dark" }),
      ),
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to this notebook" })).toBeVisible();
    await page.screenshot({
      path: `../../.squillpad-runtime/auth-${mode}-dark.png`,
    });
    await page.getByLabel("Username").fill(`collaborator-${mode}`);
    await page.getByLabel("Password", { exact: true }).fill("x");
    const createProfile = page.getByRole("button", { name: "Create profile" });
    await createProfile.focus();
    await expect(createProfile).toBeFocused();
    await createProfile.hover();
    await createProfile.press("Enter");
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
    await page.getByLabel("Username").fill(`collaborator-${mode}`);
    await page.getByLabel("Password", { exact: true }).fill("x");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Synchronized", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
