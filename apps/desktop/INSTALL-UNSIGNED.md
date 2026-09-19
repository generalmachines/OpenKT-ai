# Installing a test build of OpenKT (unsigned)

Test builds are **not signed with an Apple Developer ID and not notarised**, so macOS
blocks them the first time. This is expected. You need an Apple Silicon Mac (M1 or later)
on macOS 13.3 or later.

## 1. Install

1. Open `OpenKT-<version>-arm64.dmg`.
2. Drag **OpenKT** into **Applications**. Eject the disk image.

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

OpenKT downloads its local models by itself (about 4 GB on Macs with more than 8 GB of RAM,
about 2.6 GB otherwise) into `~/Library/Application Support/OpenKT/models/`. Keep the app open
and stay online; if the download is interrupted it resumes where it stopped. Nothing else
needs to be installed.

## Remove

Delete `/Applications/OpenKT.app` and `~/Library/Application Support/OpenKT`.

## For the maintainer: signed builds

Add the repository secrets `CSC_LINK` (base64 .p12 Developer ID Application certificate),
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The `desktop`
workflow then signs with hardened runtime and notarises — no code change
(`scripts/dist-mac.mjs`). The signed path has not been exercised yet; with hardened runtime the
bundled `llama-server` may need entitlements added to `build/entitlements.mac.plist`.
