# @openkt/desktop

The OpenKT desktop app: an Electron shell (React, Vite) built screen for screen from the design canvas in [`design/canvas/`](../../design/canvas/). It is a control pane — sessions, spaces, living pages, access, connectors, models, hotkeys — and the future home of local capture.

![A session in the desktop app, rendered from mock data](../../docs/images/desktop-session.png)

![A living page in the desktop app, rendered from mock data](../../docs/images/desktop-page.png)

## Status

- **Works now.** Every screen renders and navigates on seeded mock data (`src/api/mock/`). Unit tests cover the routes and the API adapter's request shapes.
- **Real, on this Mac.** Voice notes (whisper.cpp) and screenshots (Apple Vision OCR + the local vision model) — interim runtime, see [`src/main/models/README.md`](src/main/models/README.md). So far they are compiled and exercised only on the macOS CI runner, not on a physical Mac.
- **Stubbed.** Meeting capture runs against `StubEngine`, which returns canned text. The Swift capture engine does not exist yet; [`src/main/engine/README.md`](src/main/engine/README.md) describes the seam it will plug into.
- **Untested.** The `http` adapter (`src/api/http.ts`) follows [`docs/specs/04-api-contract.md`](../../docs/specs/04-api-contract.md) but has not been run against a live server. Methods the server does not expose yet fall back to mock data.
- **Updates.** The installed app updates itself from an S3 feed published by CI on every green `main` build — see [Updates](#updates).
- **Planned.** Wiring AI tools from the app, page editing, Developer ID signing. See [`PLAN.md`](../../PLAN.md), version 0.3.

## Run it

From the repository root, after `npm ci`:

```
npm run dev -w @openkt/desktop            # the renderer in a browser, http://localhost:5173, mock data
npm run dev:electron -w @openkt/desktop   # the Electron shell against that dev server (start `dev` first)
npm run start -w @openkt/desktop          # build, then open the Electron app
npm run typecheck -w @openkt/desktop
npm test -w @openkt/desktop
npm run build -w @openkt/desktop
```

The installed app opens on a sign-in screen (Google, or email and password) against the hosted service, `https://api.openkt.ai` — the one constant `DEFAULT_SERVER_URL` in `src/api/config.ts`; build with `VITE_OPENKT_SERVER_URL=https://…` to ship a different default. People running their own server use the quiet "Using your own server?" link on that screen, which is also where signing in with an access token lives. Google sign-in runs in the system browser (`src/main/auth/`, loopback + PKCE) with the client id the server publishes at `GET /v1/auth/providers`.

In a plain browser (`npm run dev`, the screenshot run, the tests) the app uses sample data and a stand-in sign-in that accepts any email with a password of 10+ characters. To develop against a server instead, set `VITE_OPENKT_API=http` (and optionally `VITE_OPENKT_TOKEN`) before starting.

`npm run shots -w @openkt/desktop` screenshots every route into `shots/` (not tracked) and checks that fonts loaded and nothing overflows. It needs a local Chromium; set `CHROMIUM_PATH`. It never downloads a browser.

## Updates

The installed app updates itself (`src/main/update/`, UI in `src/screens/settings/About.tsx` and `src/components/UpdatePill.tsx`).

**Releases.** Every `desktop` workflow run stamps the build `0.3.<run number>` (`scripts/stamp-version.mjs`; never committed) — shown in Settings → About with the commit and build date. On `main`, once `build` and every smoke job (`local-ai-smoke`, `capture-smoke`, `app-launch-smoke`, `update-smoke`) are green, the `release` job (environment `production`) runs `scripts/release-publish.sh`: it uploads `desktop/releases/<version>/OpenKT-<version>-arm64.{zip,dmg}` (immutable cache), the stable first-install link `desktop/OpenKT-latest-arm64.dmg` (no-cache), and **last** `desktop/latest.json` (no-cache), so a half-uploaded release is never advertised. It refuses to publish a version that is not newer than the live feed. Feed:

```json
{ "version": "0.3.128", "channel": "stable", "released_at": "…", "commit": "…", "notes": ["…"], "min_os": "13.3",
  "files": { "zip": { "url": "…/releases/0.3.128/OpenKT-0.3.128-arm64.zip", "sha256": "…", "sha512": "…", "size": 1 }, "dmg": { … } } }
```

`notes` are the commit subjects since the previous release, cleaned by `scripts/release-feed.mjs` (no `ci`/`chore`/`test` commits, no PR numbers). Dry run: `DRY_RUN=1 VERSION=… BUCKET=… BASE_URL=… ZIP=… DMG=… COMMIT=… bash scripts/release-publish.sh`.

**In the app.** 30 s after launch and every 6 h: fetch `latest.json` (5 s timeout, https only, no redirects, every URL on the pinned feed host), compare versions (never downgrade, never a rolled-back version, respect `min_os`), download the zip to `~/Library/Application Support/OpenKT/updates/<version>/` (resumable, sha256-verified — a mismatch deletes it), expand it with `ditto` into a hidden folder next to the app (same volume), verify it (`CFBundleIdentifier` = `ai.openkt.desktop`, `CFBundleShortVersionString` = the feed version, `codesign --verify --deep --strict`; a Developer ID build also requires the same TeamIdentifier), strip quarantine, then offer **Update ready — Restart**. Restart spawns a detached `/bin/sh` script (`swap.ts`) that waits for the app to exit, moves `OpenKT.app` to `OpenKT.app.old-<ts>`, moves the new bundle in, and reopens it — or puts the old one back if the move fails. The new version clears a pending-verify marker after 20 s of healthy running and deletes the old copy; if it fails to get there twice, it offers **Go back to the previous version**. Copies running from the disk image, an App-Translocated path or a read-only/unwritable folder refuse to update and offer **Move to Applications** (Electron's `moveToApplicationsFolder`).

**Signed builds.** When the app has a TeamIdentifier (`codesign -dv`) or was built with `CSC_LINK` (`openktBuild.signed`), it uses `electron-updater`'s `MacUpdater` (bundled by `scripts/bundle-updater.mjs`) with a custom provider that reads the same `latest.json` (hence `sha512`). Not exercised until a Developer ID exists.

**Proof.** `npm run test:main` covers the feed rules, resumable download and checksum failures against a local Range-capable server, bundle verification with fake `plutil`/`codesign`/`ditto`, the exact swap script (spaces and quotes) executed with `/bin/sh`, the location refusals and the rollback state machine — on Linux. The `update-smoke` CI job proves it on macOS: it installs version N from the DMG into a folder with a space in its name, serves a local feed with N+1 (the same build re-packaged with only the version bumped), launches N with `OPENKT_SMOKE=1 OPENKT_SMOKE_UPDATE=1 OPENKT_UPDATE_FEED=http://127.0.0.1:…` (the feed override is honoured only with `OPENKT_SMOKE=1`), and checks that the relaunched bundle reports N+1 and the old copy is gone.

## Layout

| Path | What |
|---|---|
| `src/app/` | Entry point and routes |
| `src/screens/` | One file per screen, matching an artboard on the canvas |
| `src/components/` | Shell, sidebar, command palette, access panel, icons |
| `src/api/` | The `OpenKTClient` interface, the mock adapter and the `http` adapter |
| `src/main/` | Electron main process: windows, tray, shortcuts, capture, the engine seam |
| `src/preload/`, `src/shared/` | The IPC bridge and its types |
| `src/styles/` | Design tokens and CSS |

The UI must match the canvas. If a screen is not on the canvas, it is not ready to build — open an issue labelled `question`.

The app bundles the Geist and Geist Mono typefaces (SIL Open Font License 1.1) through the `@fontsource-variable` packages; see [`NOTICE`](../../NOTICE).

Apache-2.0.
