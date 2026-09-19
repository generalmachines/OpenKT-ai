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
rm -f ~/Library/Application\ Support/OpenKT/permissions.json
```

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

6. **Set up on-device AI.** Do nothing.
   Expect: the download starts on its own; "About 4.6 GB — this happens once" (3.1 GB on an 8 GB
   Mac, with a line saying it uses the smaller model); free space on this Mac; a bar per model
   (Search, Understanding, Speech, Images) with speed and time left. "Inside the app" shows three ticks.
   - Click **Pause**: the bars stop, "paused at N%". Click **Resume**: they continue from the same place.
   - Click **Continue** while it is still downloading.

7. **Try it.**
   - **Write a note** → type a line → **Save note**. Expect: the card turns grey with "✓ done".
   - **Capture what you see** → **Capture** (or ⌃⌥S) → drag over some text → Save.
     Expect: the card ticks itself once the screenshot is saved.
   - **Say something** → **Start** (or ⌃⌥Space) → say a sentence → press ⌃⌥Space again → Save.
     Expect: you see your words in the pill; the card ticks itself. If the speech model is still
     downloading, the card (and the pill) say "Finishing setup — N%" instead — that is correct.

8. **Open OpenKT.**
   Expect: your sessions, with the note, the screenshot and the voice note from step 7 in the sidebar.
   While models are still downloading, the bottom of the sidebar says "Setting up on-device AI · N%".
   Settings → Permissions shows the same three rows.

## Quick negative checks (optional, 1 minute)

- Re-test from clean and click **Don’t Allow** for the microphone: the row reads "Off" with
  **Open System Settings** (it opens Privacy & Security → Microphone), and **Continue** is enabled.
- On step 2 click **Do this later** (bottom of the rail): the step shows a dashed circle and
  "Later — Settings → Permissions keeps a reminder"; Settings → Permissions shows "N off" next to its name.
- Quit OpenKT (⌘Q) in the middle of the first run and open it again: it comes back to the same step.
