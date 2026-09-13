import { startHostService } from "./host-service.js";

const portText = process.env.SQUILLPAD_PORT ?? "4173";
if (!/^\d+$/.test(portText)) throw new Error("Invalid host port");
const port = Number(portText);
const projectPath = process.env.SQUILLPAD_PROJECT;
const webRoot = process.env.SQUILLPAD_WEB_ROOT;

const service = await startHostService({
  ...(projectPath === undefined ? {} : { projectPath }),
  ...(webRoot === undefined ? {} : { webRoot }),
  port,
});

if (service.sharing().enabled) {
  for (const connection of service.sharing().connections) {
    console.log(`Client connect: ${connection.url}`);
  }
}
console.log(`SquillPad host: ${service.authorizedUrl}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await service.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
