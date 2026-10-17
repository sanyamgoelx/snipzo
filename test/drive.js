'use strict';
// Linux end-to-end test (SNIPZO_TEST=1 under Xvfb + xcompmgr): a fake desktop with an After Effects-like
// window, the pick overlay (hover, scroll, click), a real recording through x11grab with sound fed in,
// the done card, settings and a failure card. Screenshots go to SNIPZO_SHOTS. It also checks that
// picture and sound line up: the desktop flashes white at the same moment a beep is fed.
const { BrowserWindow, app } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const { performance } = require('perf_hooks');

const SHOTS = process.env.SNIPZO_SHOTS || '/tmp/shots';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
function shot(name) {
  try { execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'x11grab', '-i', process.env.DISPLAY, '-frames:v', '1', '-y', path.join(SHOTS, name + '.png')]); }
  catch (e) { console.log('shot failed', name, e.message); }
}

module.exports = async function drive(api) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const wins = JSON.parse(fs.readFileSync(process.env.SNIPZO_FAKE_WINDOWS, 'utf8'));
  const desk = new BrowserWindow({ x: 0, y: 0, width: 1600, height: 900, frame: false, show: false, backgroundColor: '#151A24' });
  await desk.loadFile(path.join(__dirname, 'desktop.html'), { query: { w: JSON.stringify(wins) } });
  desk.showInactive(); await wait(800);
  try {
    // 1. pick
    api.startPick(); await wait(1500);
    const ov = [...api.overlays.values()][0].win;
    check('overlay is showing', ov.isVisible());
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 1300, y: 60 }); await wait(200); // over a window near the top
    const barPos = await ov.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().top");
    check('toolbar stays at the top while pointing near it (clickable)', barPos < 40, 'top ' + barPos);
    shot('1-pick-open');
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 380 }); await wait(300);
    const label1 = await ov.webContents.executeJavaScript("document.getElementById('tag').textContent");
    check('hover snaps to the comp frame drawn inside the viewer (content snapping)', /frame/.test(label1) && /720 × 380/.test(label1), label1);
    shot('2-hover-viewer');
    ov.webContents.sendInputEvent({ type: 'mouseWheel', x: 800, y: 380, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true }); await wait(300);
    const label2 = await ov.webContents.executeJavaScript("document.getElementById('tag').textContent");
    check('scroll steps to the next size', label2 !== label1, label2);
    shot('3-hover-scrolled');
    // back to the default level, then click
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 40 }); await wait(150); // leaving the window resets the step
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 380 }); await wait(200);
    ov.webContents.sendInputEvent({ type: 'mouseDown', x: 800, y: 380, button: 'left', clickCount: 1 });
    ov.webContents.sendInputEvent({ type: 'mouseUp', x: 800, y: 380, button: 'left', clickCount: 1 }); await wait(300);
    const go = await ov.webContents.executeJavaScript("document.getElementById('go').textContent");
    check('Record button shows the exact size', go === 'Record 720 × 380', go);
    shot('4-selected');
    // 1b. a settled selection can be edited: drag its right edge out, move it, undo
    {
      const goText = () => ov.webContents.executeJavaScript("document.getElementById('go').textContent");
      const cur = (x, y) => ov.webContents.executeJavaScript(`(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y} })); return document.body.style.cursor; })()`);
      { const cs = [await cur(1160, 380), await cur(1158, 168), await cur(800, 380)]; check('cursor shows a resize arrow on the edge', cs.join() === 'ew-resize,nesw-resize,move', cs.join()); }
      ov.webContents.sendInputEvent({ type: 'mouseDown', x: 1160, y: 380, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 5; i++) { ov.webContents.sendInputEvent({ type: 'mouseMove', x: 1160 - i * 20, y: 380, button: 'left' }); await wait(20); }
      ov.webContents.sendInputEvent({ type: 'mouseUp', x: 1060, y: 380, button: 'left', clickCount: 1 }); await wait(150);
      const g1 = await goText();
      check('dragging the right edge resizes the selection', g1 === 'Record 620 × 380', g1);
      ov.webContents.sendInputEvent({ type: 'mouseDown', x: 700, y: 300, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 5; i++) { ov.webContents.sendInputEvent({ type: 'mouseMove', x: 700 + i * 4, y: 300 + i * 4, button: 'left' }); await wait(20); }
      ov.webContents.sendInputEvent({ type: 'mouseUp', x: 720, y: 320, button: 'left', clickCount: 1 }); await wait(150);
      const moved = await ov.webContents.executeJavaScript("document.getElementById('box').style.left");
      check('dragging inside moves it (same size)', (await goText()) === 'Record 620 × 380' && moved !== '440px', moved);
      ov.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); ov.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' }); await wait(100);
      ov.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); ov.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(100);
      ov.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); ov.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(100);
      ov.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); ov.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(150);
      const g3 = await goText(), left3 = await ov.webContents.executeJavaScript("document.getElementById('box').style.left");
      check('Ctrl+Z steps back to the original selection', g3 === 'Record 720 × 380' && left3 === '440px', g3 + ' at ' + left3);
      // a resize to nothing goes back instead of losing the selection
      ov.webContents.sendInputEvent({ type: 'mouseDown', x: 1160, y: 380, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) { ov.webContents.sendInputEvent({ type: 'mouseMove', x: 1160 - i * 90, y: 380, button: 'left' }); await wait(15); }
      ov.webContents.sendInputEvent({ type: 'mouseMove', x: 441, y: 380, button: 'left' }); await wait(20);
      ov.webContents.sendInputEvent({ type: 'mouseUp', x: 441, y: 380, button: 'left', clickCount: 1 }); await wait(150);
      check('a resize down to nothing keeps the old selection', (await goText()) === 'Record 720 × 380', await goText());
      shot('4b-edited');
    }

    // 2. drag a free box with snapping
    ov.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'right', clickCount: 1 }); await wait(100);
    ov.webContents.sendInputEvent({ type: 'mouseDown', x: 134, y: 133, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) { ov.webContents.sendInputEvent({ type: 'mouseMove', x: 134 + i * 60, y: 133 + i * 40, button: 'left' }); await wait(30); }
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 413, y: 535, button: 'left' }); await wait(60);
    ov.webContents.sendInputEvent({ type: 'mouseUp', x: 413, y: 535, button: 'left', clickCount: 1 }); await wait(200);
    const go2 = await ov.webContents.executeJavaScript("document.getElementById('go').textContent");
    check('dragged box snapped to the project panel edges (130,130 → 410,530, or 1 px in where its border is trimmed)', /^Record 2(78|80) × (398|400)$/.test(go2), go2);
    shot('5-dragged');

    // back to the viewer and record
    ov.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'right', clickCount: 1 }); await wait(100);
    ov.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 380 }); await wait(200);
    ov.webContents.sendInputEvent({ type: 'mouseDown', x: 800, y: 380, button: 'left', clickCount: 1 });
    ov.webContents.sendInputEvent({ type: 'mouseUp', x: 800, y: 380, button: 'left', clickCount: 1 }); await wait(200);
    await ov.webContents.executeJavaScript("document.getElementById('go').click()");
    await wait(300);
    check('overlay hidden once recording starts', !ov.isVisible());

    // 3. record ~4 s with sound fed in; flash + beep together at ~2 s
    const t0 = performance.now(); let sent = 0; let flashAt = null;
    const feeder = setInterval(() => {
      const need = Math.floor(((performance.now() - t0) / 1000) * 48000 / 1024) - sent;
      for (let k = 0; k < need; k++) {
        const buf = Buffer.alloc(1024 * 4);
        for (let i = 0; i < 1024; i++) {
          const tSample = t0 + ((sent * 1024 + i) / 48000) * 1000;
          const beep = flashAt != null && tSample >= flashAt && tSample < flashAt + 300;
          const v = beep ? Math.round(Math.sin((2 * Math.PI * 1000 * i) / 48000) * 20000) : 0;
          buf.writeInt16LE(v, i * 4); buf.writeInt16LE(v, i * 4 + 2);
        }
        api.feed(buf, 1024); sent++;
      }
    }, 10);
    await wait(2000);
    // the beep starts when the flash is actually painted (two animation frames after the change)
    const paintedEpoch = await desk.webContents.executeJavaScript("new Promise((r) => { document.body.classList.add('flash'); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.timeOrigin + performance.now()))); })");
    flashAt = paintedEpoch - performance.timeOrigin;
    const expectBeep = api.rec ? (flashAt - api.rec.videoStart) / 1000 : null; // where the beep must land in the file
    await wait(300);
    await desk.webContents.executeJavaScript("document.body.classList.remove('flash')");
    await wait(600);
    const barText = api.bar ? await api.bar.webContents.executeJavaScript("document.getElementById('bar').innerText") : '';
    check('recording bar shows a running timer and size', /00:0[1-9]\.\d/.test(barText) && /MB/.test(barText), barText.replace(/\s+/g, ' '));
    shot('6-recording');
    await wait(1200);
    api.onHotkey(); // the shortcut stops it
    let doneFile = null;
    for (let i = 0; i < 60 && api.state !== 'idle'; i++) await wait(250);
    clearInterval(feeder);
    await wait(800);
    const doneText = api.done ? await api.done.webContents.executeJavaScript("document.getElementById('card').innerText") : '';
    check('done card shows the saved file', /720 × 380/.test(doneText), doneText.replace(/\s+/g, ' '));
    doneFile = (doneText.match(/\/[^\n]*?\.mp4/) || [])[0];
    shot('7-done');

    // 4. check the file: size, length, sound, and that picture and sound line up
    if (doneFile && fs.existsSync(doneFile)) {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,pix_fmt,start_time:format=duration', '-of', 'json', doneFile]).toString());
      const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
      check('file is 720 × 380 yuv420p with sound', v && v.width === 720 && v.height === 380 && v.pix_fmt === 'yuv420p' && !!a, JSON.stringify(probe.streams));
      const fps = 60;
      const luma = execFileSync('ffmpeg', ['-v', 'error', '-i', doneFile, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-']);
      let flashFrame = -1; for (let f = 0; f * 64 < luma.length; f++) { let s = 0; for (let i = 0; i < 64; i++) s += luma[f * 64 + i]; if (s / 64 > 200) { flashFrame = f; break; } }
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', doneFile, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1e8 });
      let beepSample = -1; for (let i = 0; i < pcm.length / 2; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > 4000) { beepSample = i; break; }
      const aStart = Number(a.start_time || 0);
      const tv = flashFrame / fps, ta = beepSample / 48000 + aStart;
      check('both tracks start at 0', Math.abs(aStart) < 0.03 && Number(v.start_time || 0) === 0, `audio ${aStart}, video ${v.start_time}`);
      check('sound is placed where the clock says (within 25 ms)', beepSample >= 0 && expectBeep != null && Math.abs(ta - expectBeep) < 0.025, `beep at ${ta.toFixed(3)} s, expected ${expectBeep != null ? expectBeep.toFixed(3) : '?'} s`);
      console.log(`INFO screen paint delay in this virtual display: flash shows at ${tv.toFixed(3)} s, ${((tv - expectBeep) * 1000).toFixed(0)} ms after it was painted`);
    } else check('saved file exists', false, String(doneFile));

    // 5. discard and put back
    if (api.done && doneFile) {
      await api.done.webContents.executeJavaScript("document.getElementById('discard').click()"); await wait(800);
      const t = await api.done.webContents.executeJavaScript("document.getElementById('card').innerText");
      check('discard moves it to the Holding Area', /Holding Area/.test(t) && !fs.existsSync(doneFile), t.replace(/\s+/g, ' '));
      shot('8-discarded');
      await api.done.webContents.executeJavaScript("document.getElementById('undo').click()"); await wait(600);
      check('put back restores the file', fs.existsSync(doneFile));
    }

    // 5b. Start on Space: arm, wait, "tap" Space, flash 0.5 s later, tap again 1.2 s after the first
    { if (api.done) api.done.hide();
      const t1 = performance.now(); let n = 0;
      const silent = setInterval(() => { const need = Math.floor(((performance.now() - t1) / 1000) * 48000 / 1024) - n; for (let k = 0; k < need; k++) { api.feed(Buffer.alloc(4096), 1024); n++; } }, 10);
      api.startPick(); await wait(1500);
      const ov2 = [...api.overlays.values()][0].win;
      ov2.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 380 }); await wait(250);
      ov2.webContents.sendInputEvent({ type: 'mouseDown', x: 800, y: 380, button: 'left', clickCount: 1 });
      ov2.webContents.sendInputEvent({ type: 'mouseUp', x: 800, y: 380, button: 'left', clickCount: 1 }); await wait(250);
      const arm = await ov2.webContents.executeJavaScript("[document.getElementById('go').textContent, document.getElementById('go-key').disabled]");
      check('picker offers Record and On Space for this snip', arm[0] === 'Record 720 × 380' && arm[1] === false, JSON.stringify(arm));
      await ov2.webContents.executeJavaScript("document.getElementById('go-key').click()");
      await wait(1800);
      const armedText = api.bar ? await api.bar.webContents.executeJavaScript("document.getElementById('bar').innerText") : '';
      check('bar waits for Space (Ready, Cancel)', /Ready/.test(armedText) && /Press\s+Space/.test(armedText) && /Cancel/.test(armedText), armedText.replace(/\s+/g, ' '));
      shot('8b-armed');
      const amber = api.border ? await api.border.webContents.executeJavaScript("document.getElementById('f').className") : '';
      check('border is amber while waiting', /armed/.test(amber), amber);
      // Xvfb can't show transparent windows (their inside is drawn black), so the border is moved off the area for the picture checks
      if (api.border) api.border.setPosition(-3000, -3000);
      await wait(400);
      const tStart = performance.now(); api.startKey(tStart);
      await wait(500);
      const painted = await desk.webContents.executeJavaScript("new Promise((r) => { document.body.classList.add('flash'); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.timeOrigin + performance.now()))); })");
      const flashRel = (painted - performance.timeOrigin - tStart) / 1000;
      await wait(400); await desk.webContents.executeJavaScript("document.body.classList.remove('flash')");
      const recText = api.bar ? await api.bar.webContents.executeJavaScript("document.getElementById('bar').innerText") : '';
      check('after the tap the bar records and says Space stops', /00:0\d\.\d/.test(recText) && /again stops/.test(recText), recText.replace(/\s+/g, ' '));
      const red = api.border ? await api.border.webContents.executeJavaScript("document.getElementById('f').className") : '';
      check('border turns red once recording', !/armed/.test(red), red);
      await wait(300);
      const tStop = performance.now(); api.startKey(tStop);
      for (let i = 0; i < 60 && api.state !== 'idle'; i++) await wait(250);
      clearInterval(silent); await wait(800);
      const dt = api.done ? await api.done.webContents.executeJavaScript("document.getElementById('card').innerText") : '';
      check('done card says it starts at the tap', /Starts at your Space tap and ends at the next one/.test(dt), dt.replace(/\s+/g, ' '));
      const f2 = (dt.match(/\/[^\n]*?\.mp4/) || [])[0];
      if (f2 && fs.existsSync(f2)) {
        const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f2]).toString());
        const want = (tStop - tStart) / 1000, got = Number(pr.format.duration);
        check('file is exactly the time between the taps (within 50 ms)', Math.abs(got - want) < 0.05, `${got.toFixed(3)} s vs ${want.toFixed(3)} s`);
        const luma = execFileSync('ffmpeg', ['-v', 'error', '-i', f2, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-']);
        const avg = []; for (let f = 0; f * 64 < luma.length; f++) { let s2 = 0; for (let i = 0; i < 64; i++) s2 += luma[f * 64 + i]; avg.push(s2 / 64); }
        let ff = -1; for (let f = 0; f + 2 < avg.length; f++) if (avg[f] > 200 && avg[f + 1] > 200 && avg[f + 2] > 200) { ff = f; break; } // the flash lasts 400 ms
        check('the flash lands where it happened after the tap (within 60 ms)', ff > 0 && Math.abs(ff / 60 - flashRel) < 0.06, `flash at ${(ff / 60).toFixed(3)} s, painted ${flashRel.toFixed(3)} s after the tap`);
      } else check('Start on Space file exists', false, String(f2));
      shot('8c-space-done');
      // arm and cancel with the shortcut before Space: nothing saved, shown as a stop, not a failure
      const before = fs.readdirSync(path.dirname(f2 || '/tmp')).length;
      api.startPick(); await wait(1500);
      ov2.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 380 }); await wait(250);
      ov2.webContents.sendInputEvent({ type: 'mouseDown', x: 800, y: 380, button: 'left', clickCount: 1 });
      ov2.webContents.sendInputEvent({ type: 'mouseUp', x: 800, y: 380, button: 'left', clickCount: 1 }); await wait(250);
      await ov2.webContents.executeJavaScript("document.getElementById('go-key').click()"); await wait(1500);
      api.onHotkey(); await wait(1500);
      const ct = api.done ? await api.done.webContents.executeJavaScript("document.getElementById('card').innerText") : '';
      check('cancel before Space saves nothing and says "Not recorded"', /Not recorded/.test(ct) && !/failed/i.test(ct) && api.state === 'idle' && fs.readdirSync(path.dirname(f2 || '/tmp')).length === before, ct.replace(/\s+/g, ' '));
      shot('8d-cancelled');
    }

    // 6. settings and a failure card
    api.openSettings(); await wait(2500);
    // sound sync check runs end to end; the test feeds silence, so it must say the beeps were missing
    { const t1 = performance.now(); let n = 0;
      const silent = setInterval(() => { const need = Math.floor(((performance.now() - t1) / 1000) * 48000 / 1024) - n; for (let k = 0; k < need; k++) { api.feed(Buffer.alloc(4096), 1024); n++; } }, 10);
      const r = await api.settingsWin.webContents.executeJavaScript("snz.invoke('snz:sync-check')");
      clearInterval(silent);
      check('sound sync check runs and reports missing beeps honestly', r && r.ok === false && /beeps weren't in the recording/.test(r.why), JSON.stringify(r)); }
    shot('9-settings');
    const st = api.settingsWin ? await api.settingsWin.webContents.executeJavaScript("document.body.innerText") : '';
    check('settings show the shortcut and the encoder check', /Win/.test(st) && /used/.test(st), '');
    api.settingsWin && api.settingsWin.close();
    api.showDone({ ok: false, why: 'Windows refused the screen grab (Desktop duplication access denied). This happens on the lock screen and some secure windows.', kept: '/tmp/snipzo-abc123', notes: ['Mic wasn\'t recorded: no microphone was found'] });
    await wait(900); shot('10-failed');
  } catch (e) { check('test ran without errors', false, e.stack); }
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  app.exit(0);
};
