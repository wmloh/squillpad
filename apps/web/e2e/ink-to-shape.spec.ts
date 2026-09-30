import { expect, test, type Page } from "@playwright/test";

const HOLD_WAIT_MS = 850;
const rectangle = [
  [0, 0],
  [90, -2],
  [182, 2],
  [180, 60],
  [178, 118],
  [95, 122],
  [-1, 118],
  [2, 60],
  [2, 2],
];

async function freshPage(page: Page) {
  await page.goto("/");
  const canvas = page.getByLabel("Infinite page canvas", { exact: true });
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "New page", exact: true }).click();
  await page.locator(".page-list > li > .page-select").last().click();
  await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  return canvas;
}

async function drawHeld(page: Page, points = rectangle) {
  const bounds = (await page
    .getByLabel("Infinite page canvas", { exact: true })
    .boundingBox())!;
  const origin = { x: bounds.x + 140, y: bounds.y + 100 };
  await page.mouse.move(origin.x + points[0]![0]!, origin.y + points[0]![1]!);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(origin.x + point[0]!, origin.y + point[1]!, {
      steps: 3,
    });
  }
  const last = points[points.length - 1]!;
  return { x: origin.x + last[0]!, y: origin.y + last[1]! };
}

async function records(page: Page) {
  const route = new URL(page.url()).hash.split("/");
  return (
    await (await page.request.get(`/api/pages/${route[4]}/${route[6]}`)).json()
  ).canvas;
}

for (const theme of ["light", "dark"] as const) {
  test(`holds, resizes and persists one editable rectangle in ${theme} mode`, async ({
    page,
  }) => {
    if (theme === "dark") {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const canvas = await freshPage(page);
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", { name: `Switch to ${theme} mode` })
        .click();
    }
    const tip = await drawHeld(page);
    const preview = page.locator(".canvas-shape-preview");
    await expect(preview.locator("rect")).toBeVisible();
    await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
    expect(await records(page)).toHaveLength(0);
    await expect(page.locator(".canvas-ink-preview")).toBeHidden();
    const initial = (await preview.boundingBox())!;
    await page.mouse.move(tip.x - 35, tip.y - 20, { steps: 4 });
    const resized = (await preview.boundingBox())!;
    expect(resized.width).toBeCloseTo(initial.width + 35, 0);
    expect(resized.height).toBeCloseTo(initial.height + 20, 0);
    expect(resized.x + resized.width).toBeCloseTo(initial.x + initial.width, 0);
    expect(resized.y + resized.height).toBeCloseTo(
      initial.y + initial.height,
      0,
    );
    await page.screenshot({
      path: `../../.squillpad-runtime/ink-shape-preview-${theme}.png`,
    });
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    await expect(
      page.locator("[data-canvas-element-id].kind-shape rect"),
    ).toBeVisible();
    await expect(page.locator("[data-canvas-element-id].kind-ink")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Pen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await records(page)).length).toBe(1);
    const canonical = await records(page);
    expect(canonical[0].geometry.kind).toBe("rectangle");
    expect(canonical[0].style.fillColor).toBeNull();
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+z");
    await expect(
      page.locator("[data-canvas-element-id].kind-shape"),
    ).toHaveCount(1);
    await expect.poll(() => records(page)).toEqual(canonical);
    await page.reload();
    await expect(
      page.locator("[data-canvas-element-id].kind-shape rect"),
    ).toBeVisible();
    expect(await records(page)).toEqual(canonical);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page
      .locator("[data-canvas-element-id].kind-shape")
      .click({ position: { x: 25, y: 2 } });
    await expect(page.locator(".canvas-selection-overlay")).toHaveCount(1);
    const strokeWidth = page.getByLabel("Shape thickness", { exact: true });
    await expect(strokeWidth).toHaveValue(
      String(canonical[0].style.strokeWidth),
    );
    await strokeWidth.evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "6");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect
      .poll(async () => (await records(page))[0]?.style.strokeWidth)
      .toBe(6);
    await canvas.focus();
    await page.keyboard.press("Control+z");
    await expect.poll(() => records(page)).toEqual(canonical);
    await page.locator("[data-canvas-element-id].kind-shape").click({ position: { x: 25, y: 2 } });
    await expect(strokeWidth).toHaveValue(
      String(canonical[0].style.strokeWidth),
    );
    await page.screenshot({
      path: `../../.squillpad-runtime/ink-shape-committed-${theme}.png`,
    });
    expect(errors).toEqual([]);
  });
}

test("recognizes and resizes an ellipse starting away from a bounding-box corner", async ({
  page,
}) => {
  await freshPage(page);
  const points = Array.from({ length: 49 }, (_, index) => {
    const angle = Math.PI / 3 + (index * Math.PI) / 24;
    const jitter = Math.sin(index * 1.7) * 1.5;
    return [
      100 + (95 + jitter) * Math.cos(angle),
      60 + (55 + jitter) * Math.sin(angle),
    ];
  });
  const tip = await drawHeld(page, points);
  const preview = page.locator(".canvas-shape-preview");
  await expect(preview.locator("ellipse")).toBeVisible();
  const initial = (await preview.boundingBox())!;
  await page.mouse.move(tip.x + 30, tip.y + 20, { steps: 3 });
  const adjusted = (await preview.boundingBox())!;
  expect(adjusted.width).toBeCloseTo(initial.width + 30, 0);
  expect(adjusted.height).toBeCloseTo(initial.height + 20, 0);
  await page.mouse.up();
  await expect(
    page.locator("[data-canvas-element-id].kind-shape ellipse"),
  ).toBeVisible();
});

test("recognizes a stylus line and adjusts its endpoint before release", async ({
  page,
}) => {
  const canvas = await freshPage(page);
  const bounds = (await canvas.boundingBox())!;
  const client = await page.context().newCDPSession(page);
  const x = bounds.x + 140;
  const y = bounds.y + 100;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    pointerType: "pen",
  });
  for (let index = 1; index <= 15; index++) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x + index * 10,
      y: y + index * 3 + Math.sin(index),
      buttons: 1,
      pointerType: "pen",
    });
  }
  const line = page.locator(".canvas-shape-preview line");
  await expect(line).toBeVisible();
  const start = [await line.getAttribute("x1"), await line.getAttribute("y1")];
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x + 190,
    y: y + 75,
    buttons: 1,
    pointerType: "pen",
  });
  expect([
    await line.getAttribute("x1"),
    await line.getAttribute("y1"),
  ]).toEqual(start);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: x + 195,
    y: y + 80,
    button: "left",
    buttons: 0,
    pointerType: "pen",
  });
  await expect(
    page.locator("[data-canvas-element-id].kind-shape line"),
  ).toBeVisible();
  await client.detach();
});

for (const scenario of ["release early", "arrow", "highlighter"] as const) {
  test(`keeps ${scenario} strokes as ordinary ink`, async ({ page }) => {
    await freshPage(page);
    if (scenario === "highlighter")
      await page
        .getByRole("button", { name: "Highlight", exact: true })
        .click();
    await drawHeld(
      page,
      scenario === "arrow"
        ? [
            [0, 0],
            [150, 0],
            [120, -25],
            [150, 0],
            [120, 25],
          ]
        : rectangle,
    );
    if (scenario !== "release early") await page.waitForTimeout(HOLD_WAIT_MS);
    await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator("[data-canvas-element-id].kind-ink")).toHaveCount(
      1,
    );
    await page.waitForTimeout(HOLD_WAIT_MS);
    await expect(
      page.locator("[data-canvas-element-id].kind-shape"),
    ).toHaveCount(0);
  });
}

for (const phase of ["pending", "recognized"] as const) {
  test(`Escape cancels a ${phase} stroke without creating an object`, async ({
    page,
  }) => {
    await freshPage(page);
    await drawHeld(page);
    if (phase === "recognized")
      await expect(page.locator(".canvas-shape-preview")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(HOLD_WAIT_MS);
    await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
    await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
  });
}

test("tool and page changes clear the preview and cannot commit the old stroke", async ({
  page,
}) => {
  await freshPage(page);
  await drawHeld(page);
  await expect(page.locator(".canvas-shape-preview")).toBeVisible();
  await page.keyboard.press("s");
  await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await drawHeld(page);
  await page
    .getByRole("button", { name: "New page", exact: true })
    .press("Enter");
  await page.locator(".page-list > li > .page-select").last().press("Enter");
  await page.mouse.up();
  await page.waitForTimeout(HOLD_WAIT_MS);
  await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
  await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
});

test("pointer cancellation and lost capture discard recognized shapes", async ({
  page,
}) => {
  const canvas = await freshPage(page);
  for (const event of ["pointercancel", "lostpointercapture"]) {
    await drawHeld(page);
    await expect(page.locator(".canvas-shape-preview")).toBeVisible();
    await canvas.dispatchEvent(event, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
    await page.mouse.up();
    await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
    await expect(page.locator("[data-canvas-element-id]")).toHaveCount(0);
  }
});

test("fullscreen initial hold opens the radial menu, while a drawn stroke converts to a shape", async ({
  page,
}) => {
  const canvas = await freshPage(page);
  await page
    .getByRole("button", { name: "Enter fullscreen", exact: true })
    .click();
  await expect(canvas).toHaveClass(/is-fullscreen/);
  await expect(page.locator(".notebook-app")).toHaveAttribute(
    "data-fullscreen-phase",
    "open",
  );
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 200, bounds.y + 180);
  await page.mouse.down();
  await expect(
    page.getByRole("dialog", {
      name: "Long-press radial toolbar",
      exact: true,
    }),
  ).toBeVisible();
  await page.mouse.up();
  await expect(
    page.getByRole("dialog", {
      name: "Long-press radial toolbar",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose pen tool in radial toolbar" })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Long-press radial toolbar",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(canvas).toHaveClass(/is-fullscreen/);
  await drawHeld(page);
  await expect(page.locator(".canvas-shape-preview rect")).toBeVisible();
  await expect(
    page.getByRole("dialog", {
      name: "Long-press radial toolbar",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "../../.squillpad-runtime/ink-shape-preview-fullscreen.png",
  });
  await page.mouse.up();
  await expect(canvas).toHaveClass(/is-fullscreen/);
  await expect(
    page.locator("[data-canvas-element-id].kind-shape rect"),
  ).toBeVisible();
});

test("hold recognition follows the visible stroke at a changed zoom level", async ({
  page,
}) => {
  const canvas = await freshPage(page);
  const bounds = (await canvas.boundingBox())!;
  await canvas.dispatchEvent("wheel", {
    clientX: bounds.x + 200,
    clientY: bounds.y + 150,
    deltaY: -300,
    ctrlKey: true,
  });
  await expect(page.getByLabel("Zoom level")).not.toHaveText("100%");
  await drawHeld(page);
  await expect(page.locator(".canvas-shape-preview rect")).toBeVisible();
  await page.mouse.up();
  await expect(
    page.locator("[data-canvas-element-id].kind-shape rect"),
  ).toBeVisible();
});

test.describe("touch drawing preference", () => {
  test.use({ hasTouch: true });
  for (const navigates of [false, true]) {
    test(`touch ${navigates ? "navigates without making a shape" : "holds to convert when drawing is enabled"}`, async ({
      page,
    }) => {
      await page.addInitScript((penDrawsTouchNavigates) => {
        localStorage.setItem(
          "squillpad:drawing-preferences:v1",
          JSON.stringify({ penDrawsTouchNavigates }),
        );
      }, navigates);
      const canvas = await freshPage(page);
      const bounds = (await canvas.boundingBox())!;
      const client = await page.context().newCDPSession(page);
      const touch = (point: number[]) => [
        { id: 1, x: bounds.x + 140 + point[0]!, y: bounds.y + 100 + point[1]! },
      ];
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: touch(rectangle[0]!),
      });
      for (const point of rectangle.slice(1)) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touch(point),
        });
      }
      if (navigates) {
        await page.waitForTimeout(HOLD_WAIT_MS);
        await expect(page.locator(".canvas-shape-preview")).toHaveCount(0);
      } else {
        await expect(page.locator(".canvas-shape-preview rect")).toBeVisible();
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(
        page.locator("[data-canvas-element-id].kind-shape"),
      ).toHaveCount(navigates ? 0 : 1);
      await client.detach();
    });
  }
});
