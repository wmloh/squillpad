import QRCode from "qrcode";

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createProject, openProject, ProjectHierarchyService } from "@squillpad/storage";
import { createHostServer } from "../src/app.js";
import { AuthenticationService } from "../src/authentication.js";
import { HostSynchronizationService } from "../src/host-synchronization.js";

const directory = resolve("../../.squillpad-runtime/e2e");
await mkdir(directory, { recursive: true });
const root = join(await mkdtemp(join(directory, "phase6-")), "project");
let session = await createProject(root);
let synchronization!: HostSynchronizationService;
let host = await createE2eHost();
const server = createServer((request, response) => {
  if (request.url !== "/e2e/reopen") {
    host.emit("request", request, response);
    return;
  }
  void (async () => {
    await synchronization.close();
    await session.close();
    session = await openProject(root);
    host = await createE2eHost();
    response.end("Reopened canonical project");
  })().catch((error: unknown) => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
server.on("upgrade", (request, socket, head) => host.emit("upgrade", request, socket, head));
const testToken = "e".repeat(43);
const connectionUrl = `http://127.0.0.1:4274/#access_token=${testToken}`;
const qr = await QRCode.toDataURL(connectionUrl);
const securedSession = await createProject(
  join(await mkdtemp(join(directory, "security-")), "project"),
);
const securedHierarchy = new ProjectHierarchyService(securedSession);
const securedSynchronization = new HostSynchronizationService({
  hierarchy: securedHierarchy,
  projectId: (await securedSession.loadNotebook()).projectId,
  projectRoot: securedSession.projectRoot,
});
const securedAuthentication = await AuthenticationService.open(
  securedSession.projectRoot,
  testToken,
);
const securedHost = createHostServer({
  authentication: securedAuthentication,
  authenticate: (credential) => securedAuthentication.acceptsCredential(credential),
  hierarchy: securedHierarchy,
  synchronization: securedSynchronization,
  token: testToken,
  webRoot: resolve("../web/dist"),
  sharing: () => ({ enabled: true, connections: [{ url: connectionUrl, qr }] }),
});
securedHost.listen(4274, "127.0.0.1", () => server.listen(4273, "127.0.0.1"));
process.on("SIGTERM", () => {
  server.close();
  securedHost.close();
  void synchronization.close().then(() => session.close());
  void securedSynchronization.close().then(() => securedSession.close());
});

async function createE2eHost() {
  const hierarchy = new ProjectHierarchyService(session);
  const notebook = await session.loadNotebook();
  synchronization = new HostSynchronizationService({
    hierarchy,
    projectId: notebook.projectId,
    projectRoot: session.projectRoot,
  });
  return createHostServer({
    hierarchy,
    synchronization,
    sharing: () => ({
      enabled: true,
      clientLimit: synchronization.status().clientLimit,
      connectedClients: synchronization.status().connectedClients,
      clientSlotsUsed: synchronization.status().clientSlotsUsed,
      connections: [],
    }),
    setClientLimit: async (limit) => synchronization.setClientLimit(limit),
    allowedOrigins: ["http://127.0.0.1:5273"],
  });
}
