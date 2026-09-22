# SquillPad

SquillPad is a browser-based spatial notebook for keeping Markdown notes, diagrams, and freehand
ink together on one canvas. A Node.js host keeps the project folder on local disk; browsers connect
to that host locally or over a trusted local network.

*Important note: SquillPad is a personal project. The code produced by this project is entirely by AI-assisted tools. Development may be intermittent, and support, bug fixes, releases, issue responses, and pull-request reviews are not guaranteed. Use at your own risk.*

## Features

- Markdown source and rendered Markdown blocks on the same page as editable ink, highlighters,
  lines, arrows, rectangles, ellipses, and raster images.
- Host-local, human-readable project files with optional GitHub-backed snapshots.

- Markdown editing with GitHub-flavored Markdown, mathematics, syntax-highlighted code, search,
  and project-defined color styles for text, headings, links, code, math, and other elements.
- Pointer-based input for a mouse or cursor, touch, and stylus, with touch navigation and profile
  drawing palettes.
- Real-time, page-scoped collaboration over a local area network, with presence, offline editing,
  and reconnect synchronization.
- Sections and pages with reordering, duplication, copy/paste, image handling, undo/redo, laser
  pointer, fullscreen and picture-in-picture views, and Markdown/SVG/PNG export.

## Install

SquillPad is currently run from this repository; it does not include a separate desktop installer.

You need:

- Node.js 22.12 or newer. CI uses Node.js 24.20.0.
- pnpm 11. The repository package manager is pnpm 11.25.0.
- Bash for the included scripts (Windows users can use WSL or Git Bash).
- A recent Chromium browser. Firefox and Safari/WebKit should work, but are not thoroughly tested.

From the repository root, install the workspace dependencies:

```sh
pnpm install
```

If pnpm is not available, enable or install pnpm 11.25.0 through the Node.js toolchain before
continuing.

## Run the application

Open the local project chooser from the repository root:

```sh
./start-squillpad.sh
```

The chooser opens only on this host. It lists projects recorded under `launchers/`, reports moved
or invalid project folders, and can create a project using the same name, directory, and port
settings as the command-line creation script. Opening a project closes the chooser and hands the
terminal to that project's launcher. If its saved port is occupied, the chooser selects an
available port for that run.

You can also create a project and its persistent launcher directly from the command line. The
command below creates a project named `Personal Notes` outside the checkout, uses port `4173`,
builds the workspace once, and writes `launchers/personal-notes.sh`:

```sh
./scripts/create-new-project.sh \
  --name "Personal Notes" \
  --directory "$PWD/../squillpad-notes" \
  --port 4173
```

Run the generated launcher to start the host and open its authorized URL in the default browser:

```sh
./launchers/personal-notes.sh
```

Keep the terminal open while the host is running; press `Ctrl+C` to stop it. If the browser cannot
be opened automatically, use the `SquillPad host:` URL printed by the launcher. The project folder
remains on disk after the host stops, so run the same launcher whenever you want to open it again.

The project directory must be empty or absent when creating a new project. If you move an existing
project, regenerate its launcher with `--launcher-only --replace-launcher` and the new directory;
the launcher records an absolute project path.

Every time the repository is updated, you will need to run `pnpm build`. In addition, if there are changes to [package.json](package.json), you will need to run `pnpm install` before building. After these steps, you can directly run your launcher.

To run the development server against an existing project, set `SQUILLPAD_PROJECT` in the same
shell before running `pnpm dev`:

```sh
export SQUILLPAD_PROJECT="$PWD/../squillpad-notes"
pnpm dev
```

## LAN collaboration

When a project is open, the host is LAN-capable and sharing is enabled by default. The host's
Sharing controls can disable sharing or change the current client limit. Open the printed client
URL, or use the QR code shown by the host, on another device on the same trusted network. The first
connection can create a profile; later connections use that profile to sign in.

Open the same page on both devices to exchange edits in real time. If the network drops, a browser
can continue editing locally and synchronize again when it reconnects. Disabling sharing keeps the
host usable locally and stops remote clients.

LAN hosting uses unencrypted HTTP, including password login. Do not expose the host port to the
public internet or an untrusted network. See [SECURITY.md](SECURITY.md).

## Optional GitHub snapshots

The host can synchronize a project with a dedicated GitHub repository from the Sync control. This
is separate from LAN collaboration and is not required for local editing. The host runs the Git
workflow, records canonical project snapshots, fetches the configured branch, and presents reviews
for remote updates or conflicts. The workflow includes snapshot history, read-only previews,
restores as new snapshots, and choices to combine, publish local content, or apply GitHub content.

Git must be available on the host, and Git author information plus an SSH key or agent must be
configured outside SquillPad. Enter the repository as an SSH remote in the form
`git@github.com:owner/repository.git`; HTTPS remotes are not supported because SquillPad cannot
prompt for GitHub usernames or passwords. The host can edit and save the link later; local snapshot
history is preserved while the new repository is inspected. SquillPad does not collect or persist
GitHub tokens. The remote must be empty or contain a valid SquillPad project at its root; it is not
a live collaboration server.

## Project format and architecture

The project folder uses versioned, deterministic text files rather than a database:

```text
<project>/
  notebook.json
  profiles/                         # optional non-secret profile settings
    <username>.json
  sections/<section-uuid>/
    section.json
    pages/<page-uuid>/
      page.json
      canvas.jsonl
      markdown/<object-uuid>.md
      assets/<sha256>.<png|jpg|gif|webp>
```

`canvas.jsonl` stores the stable IDs, geometry, order, and styles of Markdown, ink, shape, and image
objects. Markdown prose remains in ordinary `.md` files, and raster assets are stored under the
owning page. The current canonical schema is version 2. Host-side runtime synchronization state,
locks, caches, sessions, and other disposable project data live under `.squillpad-runtime/` and are
not project content; browser offline state is kept separately by the browser.

The React/Vite browser client is in `apps/web`; the Node.js host and its HTTP/WebSocket,
authentication, and repository integration are in `apps/server`. Shared schemas and serialization,
filesystem persistence, synchronization, and reusable canvas UI are split across `packages/`.

## Known limitations

- A Node.js host process must remain running to serve the browser client and own canonical project
  saves; there is no standalone browser-only or packaged desktop mode in this repository.
- LAN transport has no built-in TLS and is intended for trusted networks.
- Stylus pressure is not captured or persisted; strokes use fixed-width styles.

## Contributing

Bug reports and pull requests are welcome, with the maintenance expectations described above. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the small development and testing loop.

## License

The repository is licensed under the GNU General Public License v3. The full license text is in
[LICENSE](LICENSE), and the root `package.json` declares the SPDX identifier `GPL-3.0-only`.
