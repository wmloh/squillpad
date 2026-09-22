import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";

const modulePath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(modulePath);
const repositoryRoot = resolve(scriptsDirectory, "..");
const launcherDirectory = join(repositoryRoot, "launchers");
const uiDirectory = join(scriptsDirectory, "project-manager-ui");
const createProjectScript = join(scriptsDirectory, "create-new-project.sh");
const maximumBodyBytes = 16 * 1024;

const contentTypes = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

export function parseLauncherHeader(source, launcherFile) {
  const values = new Map();
  for (const line of source.split(/\r?\n/, 24)) {
    const match =
      /^# (Project name|Resolved project directory|Default host port): (.*)$/.exec(
        line,
      );
    if (match !== null) values.set(match[1], match[2]);
  }
  const name = values.get("Project name");
  const projectDirectory = values.get("Resolved project directory");
  const defaultPort = Number(values.get("Default host port"));
  if (
    name === undefined ||
    projectDirectory === undefined ||
    !Number.isInteger(defaultPort) ||
    defaultPort < 0 ||
    defaultPort > 65535
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    launcher: launcherFile,
    name,
    projectDirectory,
    defaultPort,
    legacyMetadata: true,
  };
}

export function validateLauncherMetadata(value, expectedLauncher) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Metadata must be a JSON object.");
  }
  const { schemaVersion, launcher, name, projectDirectory, defaultPort } =
    value;
  if (schemaVersion !== 1) throw new Error("Unsupported metadata version.");
  if (launcher !== expectedLauncher)
    throw new Error("Metadata does not match its launcher.");
  if (typeof name !== "string" || name.trim() === "")
    throw new Error("Project name is missing.");
  if (typeof projectDirectory !== "string" || !isAbsolute(projectDirectory)) {
    throw new Error("Project path must be absolute.");
  }
  if (
    !Number.isInteger(defaultPort) ||
    defaultPort < 0 ||
    defaultPort > 65535
  ) {
    throw new Error("Default port is invalid.");
  }
  return { schemaVersion, launcher, name, projectDirectory, defaultPort };
}

async function isRealFile(path) {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function inspectProject(metadata) {
  const launcherPath = join(launcherDirectory, metadata.launcher);
  const problems = [];
  if (!(await isRealFile(launcherPath)))
    problems.push("Launcher file is missing or unsafe.");
  else {
    try {
      await access(launcherPath, fsConstants.X_OK);
    } catch {
      problems.push("Launcher is not executable.");
    }
  }
  try {
    const projectStats = await lstat(metadata.projectDirectory);
    if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
      problems.push("Project path is not a real directory.");
    } else if (
      !(await isRealFile(join(metadata.projectDirectory, "notebook.json")))
    ) {
      problems.push("Project does not contain a regular notebook.json file.");
    }
  } catch {
    problems.push("Project directory is missing.");
  }
  return {
    id: basename(metadata.launcher, ".sh"),
    name: metadata.name,
    projectDirectory: metadata.projectDirectory,
    defaultPort: metadata.defaultPort,
    legacyMetadata: metadata.legacyMetadata === true,
    available: problems.length === 0,
    problem: problems[0] ?? null,
  };
}

async function loadProject(launcherFile) {
  const metadataFile = join(
    launcherDirectory,
    `${basename(launcherFile, ".sh")}.launcher.json`,
  );
  let metadata;
  if (await isRealFile(metadataFile)) {
    try {
      metadata = validateLauncherMetadata(
        JSON.parse(await readFile(metadataFile, "utf8")),
        launcherFile,
      );
    } catch (error) {
      return {
        id: basename(launcherFile, ".sh"),
        name: basename(launcherFile, ".sh"),
        projectDirectory: "Unknown",
        defaultPort: 0,
        available: false,
        legacyMetadata: false,
        problem:
          error instanceof Error
            ? error.message
            : "Launcher metadata is invalid.",
      };
    }
  } else {
    metadata = parseLauncherHeader(
      await readFile(join(launcherDirectory, launcherFile), "utf8"),
      launcherFile,
    );
    if (metadata === undefined) {
      return {
        id: basename(launcherFile, ".sh"),
        name: basename(launcherFile, ".sh"),
        projectDirectory: "Unknown",
        defaultPort: 0,
        available: false,
        legacyMetadata: true,
        problem:
          "Launcher metadata is missing. Regenerate this launcher to repair it.",
      };
    }
  }
  return inspectProject(metadata);
}

export async function listProjects() {
  let entries;
  try {
    entries = await readdir(launcherDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const launcherFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^[a-z0-9][a-z0-9-]*\.sh$/.test(entry.name),
    )
    .map((entry) => entry.name);
  const projects = await Promise.all(launcherFiles.map(loadProject));
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function portIsAvailable(port) {
  if (port === 0) return true;
  return new Promise((resolveAvailability) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolveAvailability(false));
    probe.listen(port, "127.0.0.1", () =>
      probe.close(() => resolveAvailability(true)),
    );
  });
}

export async function chooseLaunchPort(configuredPort) {
  if (await portIsAvailable(configuredPort))
    return { port: configuredPort, overridden: false };
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        rejectPort(new Error("Could not allocate a launch port."));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort({ port, overridden: true }));
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    }
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) =>
      resolveCommand({ code, signal, output }),
    );
  });
}

function validateCreateRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid request.");
  const { name, directory, port } = body;
  if (typeof name !== "string" || name.trim() === "")
    throw new Error("Project name is required.");
  if (name.includes("\n") || name.includes("\r"))
    throw new Error("Project name cannot contain a line break.");
  if (typeof directory !== "string" || directory === "")
    throw new Error("Project directory is required.");
  if (directory.includes("\n") || directory.includes("\r"))
    throw new Error("Project directory cannot contain a line break.");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be from 0 through 65535.");
  return { name, directory, port };
}

async function openBrowser(url) {
  let command;
  let args;
  const isWsl =
    process.env.WSL_INTEROP !== undefined ||
    process.env.WSL_DISTRO_NAME !== undefined;
  if (isWsl) {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process",
      "-FilePath",
      url,
    ];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.once("error", () => {
    console.error(
      `Could not open a browser automatically. Open this URL manually: ${url}`,
    );
  });
  child.unref();
}

export async function startProjectManager({ openBrowserWindow = true } = {}) {
  const token = randomBytes(24).toString("base64url");
  let handoffStarted = false;
  let creationInProgress = false;
  let pendingLaunch;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method === "GET" &&
        contentTypes[requestUrl.pathname] !== undefined
      ) {
        const [file, contentType] = contentTypes[requestUrl.pathname];
        const body = await readFile(join(uiDirectory, file));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        });
        response.end(body);
        return;
      }
      if (request.headers["x-squillpad-manager-token"] !== token) {
        sendJson(response, 403, {
          error: "This project manager session is not authorized.",
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/projects") {
        sendJson(response, 200, { projects: await listProjects() });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/create") {
        if (creationInProgress || handoffStarted)
          throw new Error("Another project operation is already in progress.");
        const details = validateCreateRequest(await readJson(request));
        creationInProgress = true;
        try {
          const result = await runCommand(createProjectScript, [
            "--name",
            details.name,
            "--directory",
            details.directory,
            "--port",
            String(details.port),
          ]);
          if (result.code !== 0) {
            sendJson(response, 400, {
              error: result.output.trim() || "Project creation failed.",
            });
            return;
          }
          const projects = await listProjects();
          const created =
            projects.find((project) => project.name === details.name) ?? null;
          sendJson(response, 201, {
            project: created,
            output: result.output.trim(),
          });
        } finally {
          creationInProgress = false;
        }
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/open") {
        if (creationInProgress || handoffStarted)
          throw new Error("Another project operation is already in progress.");
        const body = await readJson(request);
        if (body === null || typeof body.id !== "string")
          throw new Error("Project id is required.");
        const projects = await listProjects();
        const project = projects.find((candidate) => candidate.id === body.id);
        if (project === undefined)
          throw new Error("Project launcher was not found.");
        if (!project.available)
          throw new Error(project.problem ?? "Project is unavailable.");
        const launchPort = await chooseLaunchPort(project.defaultPort);
        handoffStarted = true;
        sendJson(response, 202, { project: project.name, ...launchPort });
        pendingLaunch = { project, launchPort };
        setTimeout(() => server.close(), 350);
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  });
  server.on("clientError", (_error, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
  );
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Project manager did not acquire a port.");
  const url = `http://127.0.0.1:${address.port}/#token=${token}`;
  console.log(`SquillPad project manager: ${url}`);
  if (openBrowserWindow) await openBrowser(url);

  await new Promise((resolveClose) => server.once("close", resolveClose));
  if (pendingLaunch !== undefined) {
    const launcherPath = join(
      launcherDirectory,
      `${pendingLaunch.project.id}.sh`,
    );
    console.log(
      `Opening ${pendingLaunch.project.name} on port ${pendingLaunch.launchPort.port}...`,
    );
    const result = await runCommand(
      launcherPath,
      ["--port", String(pendingLaunch.launchPort.port)],
      { inherit: true },
    );
    if (result.signal !== null) process.kill(process.pid, result.signal);
    process.exitCode = result.code ?? 1;
  }
  return { url };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath;
if (isMain) {
  await startProjectManager({
    openBrowserWindow: process.env.SQUILLPAD_MANAGER_NO_BROWSER !== "1",
  });
}
