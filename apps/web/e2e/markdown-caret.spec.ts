import { expect, test, type Page } from "@playwright/test";

async function selectedEditorLine(page: Page): Promise<{ text: string; column: number } | null> {
  return page.locator(".markdown-editor-popover .cm-content").evaluate((content) => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (selection === null || anchor === null || !content.contains(anchor)) return null;
    const line = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(".cm-line");
    if (line === null || line === undefined) return null;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(anchor, selection.anchorOffset);
    return { text: line.textContent ?? "", column: range.toString().length };
  });
}

async function editorCaretIsVisible(page: Page): Promise<boolean> {
  return page.locator(".markdown-editor-popover .cm-scroller").evaluate((scroller) => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (selection === null || anchor === null || !scroller.contains(anchor)) return false;
    const caret = document.createRange();
    caret.setStart(anchor, selection.anchorOffset);
    caret.collapse(true);
    const caretRect = caret.getBoundingClientRect();
    const viewportRect = scroller.getBoundingClientRect();
    return caretRect.height > 0 &&
      caretRect.top >= viewportRect.top + 2 &&
      caretRect.bottom <= viewportRect.bottom - 2;
  });
}

async function editorCaretVerticalFraction(page: Page): Promise<number | null> {
  return page.locator(".markdown-editor-popover .cm-scroller").evaluate((scroller) => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (selection === null || anchor === null || !scroller.contains(anchor)) return null;
    const caret = document.createRange();
    caret.setStart(anchor, selection.anchorOffset);
    caret.collapse(true);
    const caretRect = caret.getBoundingClientRect();
    const viewportRect = scroller.getBoundingClientRect();
    return (caretRect.top + caretRect.height / 2 - viewportRect.top) / viewportRect.height;
  });
}

test("opens Markdown at the end of the double clicked heading, paragraph, or math", async ({ page }) => {
  await page.goto("/");
  const newPage = page.getByRole("button", { name: "New page", exact: true });
  await expect(newPage).toBeEnabled();
  const pages = page.locator(".page-list > li > .page-select");
  const pageCount = await pages.count();
  await newPage.click();
  await expect(pages).toHaveCount(pageCount + 1);
  await pages.last().click();

  const canvas = page.getByLabel("Infinite page canvas");
  const canvasBounds = await canvas.boundingBox();
  if (canvasBounds === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(canvasBounds.x + 220, canvasBounds.y + 120);
  const source = [
    "# Start",
    ...Array.from({ length: 45 }, (_, index) => `Earlier paragraph ${index + 1}`),
    "## Target heading",
    "Paragraph with $x^2$ math",
    "$$y = mx + b$$",
    ...Array.from({ length: 45 }, (_, index) => `Later paragraph ${index + 1}`),
  ].join("\n\n");
  await page.keyboard.insertText(source);
  await expect(page.locator(".markdown-editor-popover.is-open")).toBeVisible();
  const resizeHandle = page.getByRole("button", { name: "Resize Markdown editor" });
  const resizeBounds = await resizeHandle.boundingBox();
  if (resizeBounds === null) throw new Error("Markdown editor resize handle is unavailable");
  await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y + resizeBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBounds.x + resizeBounds.width / 2, resizeBounds.y - 160, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".markdown-editor-popover.is-custom-layout")).toBeVisible();
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(page.locator(".markdown-editor-popover")).toHaveCount(0);
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const scroller = document.querySelector<HTMLElement>(
        ".markdown-editor-popover.is-open .cm-scroller",
      );
      if (scroller === null) return;
      scroller.scrollTop = 0;
      document.documentElement.dataset.caretScrollReset = "true";
      observer.disconnect();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  });

  const markdown = page.locator(".canvas-element.kind-markdown");
  await markdown.locator("h2", { hasText: "Target heading" }).dblclick();
  const editor = page.locator(".markdown-editor-popover.is-open");
  await expect(editor).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-caret-scroll-reset", "true");
  await expect.poll(() => selectedEditorLine(page)).toEqual({
    text: "## Target heading",
    column: "## Target heading".length,
  });
  await expect.poll(() => editor.locator(".cm-scroller").evaluate((scroller) => scroller.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(() => editorCaretIsVisible(page)).toBe(true);
  await page.keyboard.insertText(" updated");
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(markdown.locator("h2")).toHaveText("Target heading updated");

  await markdown.locator("p", { hasText: "Paragraph with" }).dblclick({ position: { x: 8, y: 8 } });
  await expect.poll(() => selectedEditorLine(page)).toEqual({
    text: "Paragraph with $x^2$ math",
    column: "Paragraph with $x^2$ math".length,
  });
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  await markdown.locator("p", { hasText: "Paragraph with" }).dblclick();
  await expect.poll(() => selectedEditorLine(page)).toEqual({
    text: "Paragraph with $x^2$ math",
    column: "Paragraph with $x^2$".length,
  });
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  await markdown.locator(".katex-display").dblclick();
  await expect.poll(() => selectedEditorLine(page)).toEqual({
    text: "$$y = mx + b$$",
    column: "$$y = mx + b$$".length,
  });
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await markdown.locator("h2", { hasText: "Target heading" }).dblclick();
  await expect.poll(() => selectedEditorLine(page)).toEqual({
    text: "## Target heading updated",
    column: "## Target heading updated".length,
  });
  await expect.poll(() => editorCaretIsVisible(page)).toBe(true);
});

test("keeps the source caret in view across distant clicks in a long formatted document", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const newPage = page.getByRole("button", { name: "New page", exact: true });
  await expect(newPage).toBeEnabled();
  const pages = page.locator(".page-list > li > .page-select");
  const pageCount = await pages.count();
  await newPage.click();
  await expect(pages).toHaveCount(pageCount + 1);
  await pages.last().click();

  const canvas = page.getByLabel("Infinite page canvas");
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("Canvas bounds are unavailable");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(bounds.x + 220, bounds.y + 120);
  const lorem =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent vitae sem at augue " +
    "facilisis pulvinar. Integer feugiat, nibh id gravida bibendum, sapien ipsum mollis quam, " +
    "eget congue lacus mauris eget magna. Donec posuere, purus vel elementum laoreet, " +
    "orci massa pretium nibh, sed fermentum lectus tortor quis nisi.";
  const source = [
    "# Field notes",
    "> A long notebook entry with references, examples, and working calculations.",
    "",
    ...Array.from({ length: 200 }, (_, index) => [
      `## Section ${String(index + 1).padStart(2, "0")}: observations`,
      `${lorem} **Key point ${index + 1}** uses *emphasis* and \`inline code\` near $x^2 + y^2$.`,
      "",
      `> ${lorem}`,
      "",
      "- First observation with a [reference](https://example.com/notes).",
      "- Second observation with ~~revised wording~~.",
      "",
      "```ts",
      `const sample${index + 1} = { section: ${index + 1}, valid: true };`,
      "```",
      "",
      `$$E_${index + 1} = mc^2$$`,
      "",
      "---",
      "",
    ].join("\n")),
    "## Closing summary",
    `${lorem} The final comparison is complete.`,
  ].join("\n");
  await page.keyboard.insertText(source);
  await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
  await expect(page.locator(".markdown-editor-popover")).toHaveCount(0);
  await page.getByRole("button", { name: "Select", exact: true }).click();

  const markdown = page.locator(".canvas-element.kind-markdown");
  for (const [section, kind] of [
    [193, "heading"],
    [3, "quote"],
    [142, "code"],
    [12, "math"],
    [200, "paragraph"],
    [1, "heading"],
  ] as const) {
    const heading = `## Section ${String(section).padStart(2, "0")}: observations`;
    const target = kind === "heading"
      ? markdown.locator("h2", { hasText: heading.slice(3) })
      : kind === "quote"
        ? markdown.locator("blockquote p").nth(section)
        : kind === "code"
          ? markdown.locator("pre code").nth(section - 1)
          : kind === "math"
            ? markdown.locator(".katex-display").nth(section - 1)
            : markdown.locator("p", { hasText: `Key point ${section}` });
    const expectedLine = kind === "heading"
      ? heading
      : kind === "quote"
        ? `> ${lorem}`
        : kind === "code"
          ? "```"
          : kind === "math"
            ? `$$E_${section} = mc^2$$`
            : `${lorem} **Key point ${section}** uses *emphasis* and \`inline code\` near $x^2 + y^2$.`;
    await target.dblclick();
    await expect(page.locator(".markdown-editor-popover.is-open")).toBeVisible();
    await expect.poll(() => selectedEditorLine(page)).toEqual({ text: expectedLine, column: expectedLine.length });
    await expect.poll(() => editorCaretIsVisible(page), { message: `Caret for section ${section} should be visible` }).toBe(true);
    // A later CodeMirror measurement must not move the source away from the selected line.
    await page.waitForTimeout(500);
    const caretFraction = await editorCaretVerticalFraction(page);
    expect(caretFraction, `Source caret should stay visible for section ${section}`).not.toBeNull();
    expect(caretFraction!).toBeGreaterThan(0.02);
    expect(caretFraction!).toBeLessThan(0.98);
    await page.getByRole("button", { name: "Close Markdown editor", exact: true }).click();
    await expect(page.locator(".markdown-editor-popover")).toHaveCount(0);
    if (section === 3 || section === 12) {
      const surface = await canvas.boundingBox();
      if (surface === null) throw new Error("Canvas bounds are unavailable");
      const backgroundBeforePan = await canvas.evaluate((element) => element.style.backgroundPosition);
      await page.keyboard.down("Space");
      await page.mouse.move(surface.x + surface.width * 0.75, surface.y + surface.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(surface.x + surface.width * 0.8, surface.y + surface.height * 0.75, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      expect(await canvas.evaluate((element) => element.style.backgroundPosition)).not.toBe(backgroundBeforePan);
      await page.mouse.wheel(0, section === 3 ? -120 : 120);
      if (section === 3) await expect(page.getByLabel("Zoom level")).not.toHaveText("100%");
    }
  }
});
