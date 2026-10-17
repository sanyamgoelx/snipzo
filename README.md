# Snipzo

Snipping Tool for video. Press the shortcut (**Win + Shift + R** on Windows, **Option + Shift + R** on a Mac),
click a window or panel (or drag a box), record it with sound, press the shortcut again to stop. The MP4 is
saved in your Videos (Mac: Movies) folder and put on the clipboard as a file, so it pastes straight into
Discord, WhatsApp, Slack or a folder.

Version 0.3.0 · Electron 32 + ffmpeg · Windows 10 2004+ / 11 · macOS (Apple silicon and Intel)

## Download
From [Releases](https://github.com/sanyamgoelx/snipzo/releases/latest):
- **Windows:** `Snipzo-Portable-<version>.exe`, a single file, no install. Lives in the tray.
- **Mac:** `Snipzo-<version>-mac-arm64.dmg` (Apple silicon: M1 and later) or `-mac-x64.dmg` (Intel). Drag it to
  Applications. It isn't signed by Apple, so the first time **right-click Snipzo › Open › Open** (or run
  `xattr -cr /Applications/Snipzo.app`). It lives in the menu bar. The first snip asks for **Screen Recording**
  permission: switch Snipzo on in System Settings › Privacy & Security › Screen Recording, then quit and reopen it.

## Mac vs Windows
| | Windows | Mac |
| --- | --- | --- |
| Capture | ddagrab (GPU), NVENC / AMF / Quick Sync / x264 | avfoundation, VideoToolbox / x264 |
| Snapping | windows, their panels (After Effects' viewer), areas drawn inside | windows and areas drawn inside (Mac apps have no panel windows) |
| System sound | yes | no: macOS doesn't share it with apps like this. A loopback device (BlackHole) picked as the mic works |
| Mic | yes | yes (asks once) |
| Start on Space | yes | not yet (watching keys needs Accessibility permission) |
| Keyboard back to the picked app | yes | click into the app |
| Each new version | runs as is | macOS may ask for Screen Recording again (the app is ad-hoc signed) |

## Using it
- **Pick:** hover shows the window or panel under the mouse (After Effects' viewer, a browser's page area…), or
  the area drawn inside it (the comp frame in After Effects' viewer, a video in a player), found in a still image of the
  screen at the monitor's real pixels. A frame sitting on a plain background (the comp on AE's pasteboard) is
  preferred over shapes or guides inside it, its edges are placed to the pixel (a half-blended edge line at a
  fractional zoom is left out), and panels lose their thin plain border.
  Scroll to step to a bigger or smaller area. Click to pick it, or drag a free box; its edges snap to window and
  panel edges (hold Alt, Option on a Mac, to stop snapping). Drag the handles to adjust, Enter or **Record W × H** to start. Esc cancels.
- **Adjust before recording:** drag any edge or corner of the selection (the cursor shows the arrows), drag inside
  to move it, arrow keys nudge 1 px (Shift: 10; Ctrl, Option on a Mac: resize), Ctrl+Z (Cmd+Z) steps back, click elsewhere to pick again.
  A resize down to nothing goes back to what was there. The toolbar stays at the top while you point at it.
- **Record** starts right away and hands the keyboard back to the app you picked, so Space plays an After Effects
  comp without a click. **Start on Space** (next to Record, or Shift+Enter) is for this one snip only: Snipzo
  starts recording at once but waits (amber frame, bar says Ready); the snip begins at your Space / Numpad 0 tap
  in the app and ends at the next tap, cut exactly when saving (that part is encoded once more). Snipzo only
  watches those keys and never takes them from the app; holding Space (AE's hand tool) doesn't count. Stopping
  before Space saves nothing ("Not recorded").
- **Recording:** a dashed red frame sits just outside the area and a small bar below it (timer, size on disk,
  sound meter, Mute mic, Stop). Both sit outside the area, so neither is in the video. Only when the area
  fills the screen does the bar sit over it; then it is hidden from capture and the done card says so.
- **Screen sharing and ShadowPlay:** Snipzo never marks a window "hide from capture" unless it is over the area
  being recorded, so Discord screen shares show the picker and frame normally and ShadowPlay stays on.
- **Done:** the card shows what was really saved (length, size, pixels, fps, sound) and whether the clipboard
  holds it. Open · Show in folder · Discard (to the Holding Area; Put it back undoes it).
- **Settings** (tray icon → Settings): shortcut, save folder, 30/60 fps, quality, pointer, countdown,
  sound sources and mic, start with Windows, **Check sound sync**, live encoder check.

## How it works
| Piece | File |
| --- | --- |
| Tray, shortcut, overlays, recording flow, done card, settings | `main.js` |
| ffmpeg recording (ddagrab → NVENC/AMF/QSV/x264 into .mkv), join with sound into .mp4, ffprobe check, sync measurement | `recorder.js` |
| Keyboard hook on its own thread (shortcut + Space watcher), so a busy app can't make Windows drop it | `keyworker.js` |
| macOS calls via koffi (CoreGraphics window and display list, Screen Recording permission) + file clipboard | `mac.js` |
| Windows calls via koffi: window + panel list, DXGI monitor list, clipboard file (CF_HDROP), hide-from-capture (recording bar only, when it must sit over the area), keyboard hook, Space watcher (pass-through), focus hand-back | `win32.js` |
| Record-size math shared by the overlay and main | `geometry.js` |
| Holding Area (shared with Trimothy, Drive Cleanup, Convertino) | `holding.js` |
| Pages: pick overlay, recording bar, border, done card, settings, hidden sound recorder, sync check | `ui/` |
| Content snapping: rectangles drawn inside a panel, from long straight edges in the screen image; frame score, pixel refinement, panel border trim | `ui/content.js` |

- **Shortcut:** Win-key shortcuts belong to Windows (Win+Shift+R opens Snipping Tool's recorder), so Snipzo
  catches them with a low-level keyboard hook and swallows them; other shortcuts use a normal global shortcut.
- **Monitors:** each Electron display is matched to its DXGI adapter/output by its rectangle in physical pixels;
  ffmpeg gets `-init_hw_device d3d11va=…:<adapter>` and `ddagrab=output_idx=<output>`.
- **Sound:** a hidden window captures Windows loopback (system sound) and the mic, mixes them in Web Audio and
  sends 48 kHz stereo chunks; main writes a .wav. Picture and sound are lined up by the moment ffmpeg opened the
  screen, plus the correction measured by Check sound sync. Late sound gets real silence in front (no delayed
  track start, which trips up After Effects).
- **Honesty:** the Record button shows the exact even-pixel size given to ffmpeg; size while recording is read
  from disk; "Copied" only after the clipboard is read back; the saved file is checked (pixels, length, sound)
  before the card says saved; encoders are re-checked when settings open; a failed run keeps its raw files.

## Run, build, test
- First time: `setup.bat` (npm install). Run from source: `run.vbs` (Mac: `npm start`). Portable exe: `build.bat` → `dist\Snipzo-Portable-<version>.exe`. Mac: `npm run build:mac` on a Mac.
- CI (`.github/workflows/build.yml`): every push builds the Windows exe and both Mac apps, runs the cloud test, and runs a smoke check inside each built app (`SNIPZO_SMOKE=1`). A `v*` tag publishes those files as a GitHub release.
- Log: `%APPDATA%\snipzo\logs\snipzo.log`. Settings: `%APPDATA%\snipzo\settings.json`.
- Testing from source without clicks: write one line to `.dev-command` next to `main.js`: `snap-report` (what the picker would snap to, with screen images, into the log folder), `record x y w h secs` (a real snip of that area of the main monitor), `sync-check`, `settings`, `pick`, `log` (copies the log into `scratch/`), `quit`.
- Linux test (cloud): `test/run.sh` (Xvfb + xcompmgr, fake windows, x11grab, fed sound; 30 checks incl. editing a selection and Start on Space + screenshots).
- Snapping on a real screen image: `node test/real-bench.js <rgba dump> w h x y w h`.
- Snapping bench: `node test/content-bench.js` (synthetic AE viewers at 100/125/150 %, fractional comp edges, a gap in an edge, a black comp).
- `snap-report` also copies its JSON and screen images into `scratch/` when run from source.
