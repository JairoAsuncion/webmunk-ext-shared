# Webmunk Shopping Study — Extension Source (Read-Only Export)

This repository is a read-only export of the source files that make up the
Webmunk Shopping Study Chrome extension - specifically, the files that are
bundled into the package submitted to the Chrome Web Store.

It is synced automatically from a private development repository and does
**not** include build tooling, tests, deployment scripts, or project
documentation. Please don't push directly here - commits will be
overwritten by the next sync.

## Structure

- `src/chrome/baseManifest.json` - extension manifest
- `src/content/` - content script (runs on Amazon product pages)
- `src/worker/` - background service worker (Firebase, survey/event logic)
- `src/popup/` - extension popup UI
- `src/utils/`, `src/enums.ts`, `src/types.ts`, `src/config.js` - shared types/config
- `images/UvA.png` - the extension icon (the only image shipped in the store package)
