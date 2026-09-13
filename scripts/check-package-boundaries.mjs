import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const rules = [
  {
    manifest: "packages/core-model/package.json",
    forbidden: ["react", "react-dom", "electron", "node:fs", "node:fs/promises"],
  },
  {
    manifest: "packages/storage/package.json",
    forbidden: ["react", "react-dom", "electron"],
  },
  {
    manifest: "apps/web/package.json",
    forbidden: ["electron", "node:fs", "node:fs/promises"],
  },
];

for (const rule of rules) {
  const source = await readFile(new URL(`../${rule.manifest}`, import.meta.url), "utf8");
  const manifest = JSON.parse(source);
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };

  for (const dependency of rule.forbidden) {
    assert.equal(
      dependency in declared,
      false,
      `${rule.manifest} must not depend on ${dependency}`,
    );
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return files.flat().filter((path) => /\.[cm]?[jt]sx?$/.test(path.pathname));
}

const webSource = new URL("../apps/web/src/", import.meta.url);
for (const path of await sourceFiles(webSource)) {
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["'](?:node:)?fs(?:\/promises)?["']/u);
}
