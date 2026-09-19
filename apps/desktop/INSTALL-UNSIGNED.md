# Installing a test build of OpenKT (unsigned)

Test builds are **not signed with an Apple Developer ID and not notarised**, so macOS
blocks them the first time. This is expected. You need an Apple Silicon Mac (M1 or later)
on macOS 13.3 or later.

**You do this once.** After the first install OpenKT updates itself from inside the app — no more
disk images (see [Updates](#updates)).

## 1. Install

1. Download the latest build: <https://openkt-downloads-724772068721.s3.ap-south-1.amazonaws.com/desktop/OpenKT-latest-arm64.dmg>
   (this link always points at the newest release).
2. Open the disk image and drag **OpenKT** into **Applications**. Eject the disk image.
   Do not run OpenKT from the disk image: it cannot update itself from there. If you do open it
   from the disk image, it offers **Move to Applications** and does the move for you.

## 2. Allow it to open (once)

On macOS 15 (Sequoia) and later, right-click → Open no longer bypasses the block (on macOS 13–14 it still
works). Either way below works on every version:

**A — System Settings**

1. Double-click OpenKT in Applications. macOS says it cannot be opened / could not verify
   it is free of malware. Click **Done** (not "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down to **Security**.
3. Next to *"OpenKT" was blocked to protect your Mac*, click **Open Anyway** and confirm with
   Touch ID or your password.
4. Open OpenKT again and click **Open Anyway** in the dialog. It is not asked again.

**B — Terminal (one line)**

```sh
xattr -dr com.apple.quarantine /Applications/OpenKT.app
```

Then open OpenKT normally. If macOS says the app **"is damaged and can't be opened"**, that is
the same quarantine block worded differently — use B.

## 3. First launch

OpenKT downloads its local models by itself (about 4.6 GB on Macs with more than 8 GB of RAM,
about 3.1 GB otherwise — text, embeddings, speech and vision) into `~/Library/Application Support/OpenKT/models/`. Keep the app open
and stay online; if the download is interrupted it resumes where it stopped. Nothing else
needs to be installed.

## 4. Voice notes and screenshots

- **Voice note — Control+Option+Space.** The first time, macOS asks whether OpenKT may use the
  **microphone**: click **Allow**. If you clicked Don't Allow, turn it on in **System Settings →
  Privacy & Security → Microphone → OpenKT**. Press the shortcut again to stop; the words appear
  a moment later (transcription runs on this Mac, after you stop — there is no live text yet).
  The audio file is deleted as soon as it has been transcribed.
- **Screenshot — Control+Option+S**, then drag over the part of the screen you want (Esc cancels).
  macOS only lets an app capture other apps' windows when **Screen Recording** is on for it:
  **System Settings → Privacy & Security → Screen Recording** (on macOS 15: **Screen & System Audio
  Recording**) **→ enable OpenKT → quit and reopen OpenKT**. Without it, screenshots show only your
  desktop picture and OpenKT's own windows.
- The `fn` key is not used yet.

## Updates

OpenKT checks for a new version 30 seconds after it starts and every 6 hours, downloads it in the
background, and shows **Update ready — Restart** at the bottom of the sidebar. Click it (or
**Settings → About → Restart to update**) and OpenKT quits, replaces itself and opens again on the new
version; the first time it shows *Updated to 0.3.x — what's new*. You never have to allow it again
in Privacy & Security.

- **OpenKT → Check for Updates…** (menu bar) or **Settings → About → Check now** checks right away.
- **Settings → About → Download updates automatically** (on by default): turn it off and OpenKT still
  checks, but asks before it downloads anything.
- If a new version fails to start twice in a row, OpenKT offers **Go back to the previous version**
  and does not offer that version again.
- If macOS says OpenKT was prevented from modifying apps, allow it in **System Settings → Privacy &
  Security → App Management**, then choose **Restart to update** again. Your current version keeps
  working either way.

## Remove

Delete `/Applications/OpenKT.app` and `~/Library/Application Support/OpenKT` (downloaded updates live
in its `updates/` folder).

## For the maintainer: signed builds

Add the repository secrets `CSC_LINK` (base64 .p12 Developer ID Application certificate),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The `desktop`
workflow then signs with hardened runtime and notarises — no code change
(`scripts/dist-mac.mjs`). The signed path has not been exercised yet; with hardened runtime the
bundled `llama-server` may need entitlements added to `build/entitlements.mac.plist`. Signed builds
update through `electron-updater` (Squirrel.Mac) from the same feed; see the README's *Updates*.
