import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PROFILE_SETTINGS, type ProfileDrawingPalettes } from "@squillpad/core-model";
import { createProject, ProfileSettingsStore } from "@squillpad/storage";
import { afterEach, expect, it } from "vitest";

import { AuthenticationService, sessionCookieHeader } from "./authentication.js";

const sessions: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

it("persists salted password credentials and hashed revocable sessions per project", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-auth-")), "project");
  const project = await createProject(root);
  sessions.push(project);
  const hostToken = "h".repeat(43);
  const authentication = await AuthenticationService.open(root, hostToken);

  const sessionToken = await authentication.register("Alice", "correct horse battery staple");
  expect(authentication.acceptsCredential(sessionToken)).toBe(true);
  expect(authentication.status(request({ cookie: cookieValue(sessionToken) }))).toMatchObject({
    authenticated: true,
    username: "alice",
    palmRejection: false,
  });
  await authentication.updateToolbarHeight(request({ cookie: cookieValue(sessionToken) }), 72);
  await authentication.updatePalmRejection(request({ cookie: cookieValue(sessionToken) }), true);
  const drawingPalettes = profileDrawingPalettes();
  await authentication.updateDrawingPalettes(
    request({ cookie: cookieValue(sessionToken) }),
    drawingPalettes,
  );
  expect(authentication.status(request({ cookie: cookieValue(sessionToken) }))).toMatchObject({
    toolbarHeight: 72,
    palmRejection: true,
    drawingPalettes,
  });
  expect(
    authentication.status(
      request({ authorization: `Bearer ${hostToken}`, cookie: cookieValue(sessionToken) }),
    ),
  ).toMatchObject({ hostAuthorized: true, username: "alice" });

  const stored = await readFile(
    join(root, ".squillpad-runtime", "auth", "credentials.json"),
    "utf8",
  );
  expect(stored).not.toContain("correct horse battery staple");
  expect(stored).not.toContain(sessionToken);

  const reopened = await AuthenticationService.open(root, hostToken);
  expect(reopened.acceptsCredential(sessionToken)).toBe(true);
  expect(reopened.status(request({ cookie: cookieValue(sessionToken) }))).toMatchObject({
    toolbarHeight: 72,
    palmRejection: true,
    drawingPalettes,
  });
  await expect(
    reopened.updateToolbarHeight(request({ cookie: cookieValue(sessionToken) }), 121),
  ).rejects.toThrow("toolbarHeight must be an integer between 24 and 120 pixels");
  await expect(
    reopened.updatePalmRejection(request({ cookie: cookieValue(sessionToken) }), "yes" as never),
  ).rejects.toThrow("palmRejection must be a boolean");
  await reopened.logout(request({ cookie: cookieValue(sessionToken) }));
  expect(reopened.acceptsCredential(sessionToken)).toBe(false);
  expect(
    reopened.acceptsCredential(await reopened.login("alice", "correct horse battery staple")),
  ).toBe(true);
});

it("accepts passwords without composition rules and invalidates sessions on reset or removal", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-auth-")), "project");
  const project = await createProject(root);
  sessions.push(project);
  const authentication = await AuthenticationService.open(root, "a".repeat(43));

  await expect(authentication.register("x", "short")).rejects.toMatchObject({ status: 400 });
  const shortPasswordToken = await authentication.register("short-password", "x");
  expect(authentication.acceptsCredential(shortPasswordToken)).toBe(true);
  await authentication.removeAccount("short-password");
  const token = await authentication.register("editor", "first password value");
  await authentication.resetPassword("editor", "replacement password");
  expect(authentication.acceptsCredential(token)).toBe(false);
  await expect(authentication.login("editor", "first password value")).rejects.toMatchObject({
    status: 401,
  });
  expect(
    authentication.acceptsCredential(await authentication.login("editor", "replacement password")),
  ).toBe(true);
  await authentication.removeAccount("editor");
  expect(authentication.listAccounts()).toEqual([]);
});

it("stores complete profile settings separately from credentials", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-auth-")), "project");
  const project = await createProject(root);
  sessions.push(project);
  const profileStore = await ProfileSettingsStore.open(root);
  const authentication = await AuthenticationService.open(root, "h".repeat(43), profileStore);
  const sessionToken = await authentication.register("Alice", "correct horse battery staple");
  const profileRequest = request({ cookie: cookieValue(sessionToken) });
  const settings = {
    ...DEFAULT_PROFILE_SETTINGS,
    application: { theme: "dark" as const, pageBackground: "blank" as const },
    drawing: { ...DEFAULT_PROFILE_SETTINGS.drawing, radialToolbarEnabled: false },
  };

  await expect(authentication.saveProfileSettings(profileRequest, settings)).resolves.toEqual(
    settings,
  );
  await authentication.updateToolbarHeight(profileRequest, 72);
  expect(authentication.profileSettings(profileRequest)).toMatchObject({
    application: settings.application,
    drawing: settings.drawing,
    toolbarHeight: 72,
  });
  expect((await ProfileSettingsStore.open(root)).get("alice")).toMatchObject({
    application: settings.application,
    drawing: settings.drawing,
    toolbarHeight: 72,
  });
  const credentials = await readFile(
    join(root, ".squillpad-runtime", "auth", "credentials.json"),
    "utf8",
  );
  expect(credentials).not.toContain(sessionToken);
  expect(await readFile(join(root, "profiles", "alice.json"), "utf8")).not.toContain(sessionToken);
});

it("creates a persistent HttpOnly same-site cookie", () => {
  expect(sessionCookieHeader("s".repeat(43))).toContain(
    "Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000",
  );
  expect(sessionCookieHeader("s".repeat(43), true)).toContain("; Secure");
});

function request(headers: {
  readonly authorization?: string;
  readonly cookie?: string;
}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function profileDrawingPalettes(): ProfileDrawingPalettes {
  const slots = [
    { color: "#111111", width: 2, opacity: 1 },
    { color: "#222222", width: 3, opacity: 1 },
    { color: "#333333", width: 4, opacity: 0.8 },
    { color: "#444444", width: 5, opacity: 0.7 },
    { color: "#555555", width: 6, opacity: 0.6 },
    { color: "#666666", width: 7, opacity: 0.5 },
  ];
  return {
    pen: { custom: true, selectedIndex: 2, slots },
    highlighter: { custom: false, selectedIndex: 0, slots },
    shape: { custom: true, selectedIndex: 1, slots },
  };
}

function cookieValue(token: string): string {
  return `squillpad_session=${token}`;
}
