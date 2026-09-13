import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startHostService, type HostService } from "./host-service.js";
import { createProject, ProjectHierarchyService } from "@squillpad/storage";

const services: HostService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

it("starts a reusable host and stops its listener from the host API", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "squillpad-host-service-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>SquillPad</title>");
  const service = await startHostService({ port: 0, webRoot });
  services.push(service);

  expect(service.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(await (await fetch(`${service.origin}/health`)).json()).toMatchObject({ status: "ok" });
  await service.flush();

  const stopped = await fetch(`${service.origin}/api/host/stop`, { method: "POST" });
  expect(stopped.status).toBe(202);
  expect(await stopped.json()).toEqual({ stopping: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.close();
  expect((await fetch(`${service.origin}/health`).catch(() => undefined))?.ok).not.toBe(true);
});

it("uses the project sharing default and toggles remote access without stopping the host", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-host-project-")), "project");
  const session = await createProject(root);
  await new ProjectHierarchyService(session).updateLanSharingDefault(false);
  await session.close();

  const service = await startHostService({ port: 0, projectPath: root });
  services.push(service);
  expect(service.sharing()).toMatchObject({ enabled: false, defaultEnabled: false });
  const headers = {
    authorization: `Bearer ${service.accessToken}`,
    "content-type": "application/json",
  };

  const enabled = await fetch(`${service.origin}/api/sharing`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({
    enabled: true,
    defaultEnabled: false,
    clientLimit: 5,
    clientSlotsUsed: 1,
  });
  expect((await fetch(`${service.origin}/health`)).ok).toBe(true);

  const disabled = await fetch(`${service.origin}/api/sharing`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: false }),
  });
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({
    enabled: false,
    defaultEnabled: false,
    clientLimit: 5,
    clientSlotsUsed: 1,
  });
});

it("applies a host-only client limit in memory and resets it on relaunch", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "squillpad-host-limit-")), "project");
  const session = await createProject(root);
  await session.close();

  const service = await startHostService({ port: 0, projectPath: root });
  services.push(service);
  expect(service.sharing()).toMatchObject({ clientLimit: 5, clientSlotsUsed: 1 });
  const headers = {
    authorization: `Bearer ${service.accessToken}`,
    "content-type": "application/json",
  };

  const updated = await fetch(`${service.origin}/api/sharing`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientLimit: 12 }),
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ clientLimit: 12 });
  expect(service.sharing()).toMatchObject({ clientLimit: 12 });

  const invalid = await fetch(`${service.origin}/api/sharing`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientLimit: 21 }),
  });
  expect(invalid.status).toBe(400);

  await service.close();
  const relaunched = await startHostService({ port: 0, projectPath: root });
  services.push(relaunched);
  expect(relaunched.sharing()).toMatchObject({ clientLimit: 5, clientSlotsUsed: 1 });
});
