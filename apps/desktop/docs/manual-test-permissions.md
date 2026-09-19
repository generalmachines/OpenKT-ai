# Manual test: first run on a Mac (about 3 minutes)

What the automated tests cannot prove, because they run without a Mac: that macOS actually shows
its prompts, that the System Settings links land on the right switch, and that the relaunch after
Screen Recording comes back to the same step. Do this on an Apple-silicon Mac with the DMG build.

If anything differs from **Expect**, note the step number and take a screenshot.

## Start clean (only when re-testing)

Quit OpenKT, then in Terminal:

```
tccutil reset Microphone ai.openkt.desktop
tccutil reset ScreenCapture ai.openkt.desktop
tccutil reset Accessibility ai.openkt.desktop
rm -f ~/Library/Application\ Support/OpenKT/permissions.json ~/Library/Application\ Support/OpenKT/models-choice.json
```

To see the model choice again after models were downloaded, also move `~/Library/Application Support/OpenKT/models`
to the Trash (4–5 GB).

A brand-new account starts the first run by itself. To see it again with an existing account,
also remove `~/Library/Application Support/OpenKT/Local Storage` (you will have to sign in again).

## The run

1. **Open OpenKT and create an account** (or sign in).
   Expect: "Allow access", step 2 of 5 in the left rail. Three rows — Microphone, Screen Recording,
   Accessibility — each "Not asked yet" with an **Allow** button. Meetings shows "coming soon".
   **Continue** is greyed out.

2. **Microphone → Allow.**
   Expect: the macOS prompt "“OpenKT” would like to access the microphone". Click Allow. Within
   about 2 seconds the row reads "Allowed · ✓ Granted" and **Continue** turns orange.

3. **Screen Recording → Allow.**
   Expect: the macOS prompt about recording the screen. Choose **Open System Settings** in that
   prompt; System Settings opens at Privacy & Security → Screen & System Audio Recording with
   OpenKT in the list. Turn OpenKT on.
   - If macOS offers **Quit & Reopen**, use it. Otherwise go back to OpenKT: a box
     "Turned on Screen Recording?" is there — click **Relaunch OpenKT**.
   - Expect: OpenKT closes and reopens **on the same "Allow access" screen**, with Screen
     Recording "Allowed".
   - If no macOS prompt appeared at all, the row now says **Open System Settings** — click it; it
     must open the same Screen Recording pane.

4. **Accessibility → Allow.**
   Expect: the macOS prompt "“OpenKT” would like to control this computer using accessibility
   features". Click **Open System Settings**, turn OpenKT on, come back. The row reads "Allowed"
   within about 2 seconds — no relaunch needed.

5. **Continue** → "Connect your tools" → continue to step 4.

6. **Set up on-device AI.** Do nothing at first.
   Expect: **nothing downloads by itself.** Four open-source models, each with its job, name, licence and
   size — Qwen3-Embedding-0.6B (Apache-2.0), Qwen3.5-4B (Apache-2.0), Whisper large-v3-turbo (MIT),
   Qwen3.5-4B vision (Apache-2.0); on an 8 GB Mac the 2B model and Whisper small, with a line saying so.
   "Everything runs on this Mac — nothing is sent to a cloud model." "4.6 GB in total". Free space on this Mac.
   - Click a model name: its Hugging Face page opens in your browser.
   - Click **Download models (4.6 GB)**: a bar per model with speed and time left.
     **Pause** stops it ("paused at N%"); **Resume** continues from the same place. Then **Continue**.
   - (Second run, optional) click **Later** instead: you move on, the rail says "Later — Settings → Models",
     Settings → Models shows **Download on-device AI** with "not set up" next to its name, and the bottom
     of the sidebar says "Download on-device AI · 4.6 GB".

7. **Try it.**
   - **Write a note** → type a line → **Save note**. Expect: the card turns grey with "✓ done".
   - **Capture what you see** → **Capture** (or ⌃⌥S) → drag over some text → Save.
     Expect: the card ticks itself once the screenshot is saved.
   - **Say something** → **Start** (or ⌃⌥Space) → say a sentence → press ⌃⌥Space again → Save.
     Expect: you see your words in the pill; the card ticks itself. If the speech model is still
     downloading, the card and the pill say how far along it is. If you chose **Later**, they say
     "Voice needs the speech model (574 MB)" with a button that downloads just that.

8. **Open OpenKT.**
   Expect: your sessions, with the note, the screenshot and the voice note from step 7 in the sidebar.
   While models are still downloading, the bottom of the sidebar says "Setting up on-device AI · N%".
   Quit and reopen while it downloads: it carries on by itself (you already chose). It never starts on its own.
   Settings → Permissions shows the same three rows.

## Quick negative checks (optional, 1 minute)

- Re-test from clean and click **Don’t Allow** for the microphone: the row reads "Off" with
  **Open System Settings** (it opens Privacy & Security → Microphone), and **Continue** is enabled.
- On step 2 click **Do this later** (bottom of the rail): the step shows a dashed circle and
  "Later — Settings → Permissions keeps a reminder"; Settings → Permissions shows "N off" next to its name.
- Quit OpenKT (⌘Q) in the middle of the first run and open it again: it comes back to the same step.
