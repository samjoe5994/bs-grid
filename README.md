# bs-grid

[![npm version](https://img.shields.io/npm/v/@samjoe5994/bs-grid.svg)](https://www.npmjs.com/package/@samjoe5994/bs-grid)
[![CI](https://github.com/samjoe5994/bs-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/samjoe5994/bs-grid/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Live demo](https://samjoe5994.github.io/bs-grid/)**

Monorepo for **[@samjoe5994/bs-grid](https://www.npmjs.com/package/@samjoe5994/bs-grid)** — a zero-dependency Angular data grid, MIT licensed.

Package docs (install, API, theming): [`projects/bs-grid/README.md`](projects/bs-grid/README.md).

## Layout

```
projects/
  bs-grid/     the published library
  demo/        playground app (not published)
```

## Develop

```bash
npm install
npm run build:lib      # ng build bs-grid  -> dist/bs-grid
npm start              # builds the lib, then serves the demo on :4200
npm run watch:lib      # rebuild the lib on change (run alongside `ng serve demo`)
npm test               # unit tests for the library
```

The demo imports the library through the `@samjoe5994/bs-grid` path mapping in `tsconfig.json`, which points at `dist/bs-grid` — so **build the library before serving the demo**.

## Release

```bash
npm run pack:lib       # build + npm pack, inspect the tarball before shipping
npm run publish:lib    # build + npm publish from dist/bs-grid
```

Publishing runs from `dist/bs-grid`, never from the repo root. Bump `version` in `projects/bs-grid/package.json`, tag the commit, and push — the GitHub Actions workflow publishes on release using npm **trusted publishing (OIDC)**, so no npm token is stored in the repo.

First release only: publish manually once to claim the name, then configure the trusted publisher on npmjs.com (owner `samjoe5994`, repo `bs-grid`, workflow filename `publish.yml`).

The demo deploys to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

## Contributing

Issues and PRs welcome. Keep the library dependency-free — the whole point is that installing it pulls in nothing but Angular.

MIT © BlockSurvey
