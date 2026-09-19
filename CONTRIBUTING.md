# Contributing to SquillPad

Bug reports and pull requests are welcome, but SquillPad is primarily a personal project rather
than an actively maintained community project. Responses, reviews, merges, fixes, and releases are
not guaranteed. If you are planning substantial independent development, maintaining it as a fork
may be the most practical option.

## Local setup

The repository uses a pnpm workspace. Use Node.js 22.12 or newer and pnpm 11; CI uses Node.js
24.20.0 and the repository declares pnpm 11.25.0 in `package.json`.

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the shared packages and starts the browser client and host together. For the
production-style application launch, see [README.md](README.md#run-the-application).

## Checks

Add or update focused tests beside changed behavior when practical. The repository provides these
checks:

```sh
pnpm test
pnpm test:e2e
pnpm typecheck
```

`pnpm test` builds shared packages, checks package boundaries, and runs unit tests. The end-to-end
command builds the application and runs the Playwright workflows. Install Chromium once if that
workflow needs it:

```sh
pnpm --filter @squillpad/web exec playwright install chromium
```

Use `pnpm format` to apply the repository's Prettier formatting.
