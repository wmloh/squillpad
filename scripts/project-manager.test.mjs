import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  chooseLaunchPort,
  parseLauncherHeader,
  validateLauncherMetadata,
} from "./project-manager.mjs";

test("parses metadata from a generated legacy launcher header", () => {
  const metadata = parseLauncherHeader(
    [
      "#!/usr/bin/env bash",
      "",
      "# SquillPad project launcher",
      "# Project name: Field Notes",
      "# Directory entered: ~/field-notes",
      "# Resolved project directory: /home/example/field-notes",
      "# Host port response: 4173",
      "# Default host port: 4173",
    ].join("\n"),
    "field-notes.sh",
  );

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    launcher: "field-notes.sh",
    name: "Field Notes",
    projectDirectory: "/home/example/field-notes",
    defaultPort: 4173,
    legacyMetadata: true,
  });
});

test("rejects incomplete launcher headers", () => {
  assert.equal(
    parseLauncherHeader("# Project name: Incomplete", "incomplete.sh"),
    undefined,
  );
});

test("validates machine-readable launcher metadata", () => {
  assert.deepEqual(
    validateLauncherMetadata(
      {
        schemaVersion: 1,
        launcher: "field-notes.sh",
        name: "Field Notes",
        projectDirectory: "/srv/field-notes",
        defaultPort: 0,
      },
      "field-notes.sh",
    ),
    {
      schemaVersion: 1,
      launcher: "field-notes.sh",
      name: "Field Notes",
      projectDirectory: "/srv/field-notes",
      defaultPort: 0,
    },
  );
});

test("rejects metadata that points at another launcher", () => {
  assert.throws(
    () =>
      validateLauncherMetadata(
        {
          schemaVersion: 1,
          launcher: "other.sh",
          name: "Field Notes",
          projectDirectory: "/srv/field-notes",
          defaultPort: 4173,
        },
        "field-notes.sh",
      ),
    /does not match/,
  );
});

test("chooses a temporary override when a configured port is occupied", async (context) => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => occupied.close(resolve)));
  const address = occupied.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const result = await chooseLaunchPort(address.port);

  assert.equal(result.overridden, true);
  assert.notEqual(result.port, address.port);
  assert.ok(result.port > 0 && result.port <= 65535);
});
