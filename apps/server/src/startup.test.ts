import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject } from "@squillpad/storage";

const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  children.length = 0;
});

async function start(
  args: string[],
  projectPath?: string,
): Promise<{
  readonly child: ReturnType<typeof spawn>;
  readonly url: URL;
  readonly output: string;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", ...args], {
    env: {
      ...process.env,
      SQUILLPAD_PROJECT: projectPath,
      SQUILLPAD_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise<{
    readonly child: ReturnType<typeof spawn>;
    readonly url: URL;
    readonly output: string;
  }>((resolve, reject) => {
    let output = "";
    child.on("error", reject);
    child.once("exit", () => reject(new Error("Host exited before startup")));
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /SquillPad host: (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) resolve({ child, url: new URL(match[1]), output });
    });
  });
}

it("starts on localhost by default and reports the OS-assigned port", async () => {
  const { url, output } = await start([]);
  expect(url.hostname).toBe("127.0.0.1");
  expect(Number(url.port)).toBeGreaterThan(0);
  expect(url.hash).toBe("");
  expect(output).not.toContain("LAN sharing:");
  expect(await (await fetch(new URL("/api/sharing", url))).json()).toEqual({
    enabled: false,
    connections: [],
  });
});

it("project startup enables LAN sharing and issues fresh authorized URLs", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "squillpad-startup-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "squillpad-startup-"));
  const firstProject = await createProject(join(firstRoot, "project"));
  const secondProject = await createProject(join(secondRoot, "project"));
  await firstProject.close();
  await secondProject.close();
  const first = await start([], join(firstRoot, "project"));
  const second = await start([], join(secondRoot, "project"));
  const token = new URLSearchParams(first.url.hash.slice(1)).get("access_token")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.url.hash).not.toBe(second.url.hash);
  expect((await fetch(new URL("/api/sharing", first.url))).status).toBe(401);
  const response = await fetch(new URL("/api/sharing", first.url), {
    headers: { authorization: `Bearer ${token}` },
  });
  const sharing = (await response.json()) as {
    enabled: boolean;
    connections: { url: string; qr: string }[];
  };
  expect(sharing.enabled).toBe(true);
  for (const connection of sharing.connections) {
    const url = new URL(connection.url);
    expect(url.port).toBe(first.url.port);
    expect(url.hash).toBe(first.url.hash);
    expect(connection.qr).toMatch(/^data:image\/png;base64,/);
    expect(first.output).toContain(connection.url);
    expect(
      (
        await fetch(new URL("/api/sharing", url), {
          headers: { authorization: `Bearer ${token}`, origin: url.origin },
        })
      ).status,
    ).toBe(403);
  }
});

it("exits and releases the project lock when hosting is stopped through the API", async () => {
  const projectPath = join(await mkdtemp(join(tmpdir(), "squillpad-stop-startup-")), "project");
  const session = await createProject(projectPath);
  await session.close();

  const running = await start([], projectPath);
  const token = new URLSearchParams(running.url.hash.slice(1)).get("access_token");
  if (token === null) throw new Error("Expected the project host URL to include an access token");
  const exited = once(running.child, "exit");
  const response = await fetch(new URL("/api/host/stop", running.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ stopping: true });
  await expect(
    Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Host did not exit after hosting stopped")), 3_000),
      ),
    ]),
  ).resolves.toEqual([0, null]);

  const reopened = await openProject(projectPath);
  await reopened.close();
});
