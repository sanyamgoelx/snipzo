'use strict';
// Snipzo: records one area of one monitor.
//  Mac: ffmpeg's avfoundation grabs the whole screen ("Capture screen N"), cropped to the area on the CPU,
//  encoded by VideoToolbox (then x264). Everything after the picture (sound, join, checks) is the same.
//  Picture: ffmpeg's ddagrab (Windows Desktop Duplication, on the GPU) cropped to the area, encoded by the
//  first encoder that works (NVENC, AMF, Quick Sync, then x264 on the CPU), into a temporary .mkv
//  (an .mkv stays playable even if something crashes mid-recording).
//  Sound: system sound and the mic are captured in a hidden window (see audio.html) and arrive here as
//  48 kHz stereo 16-bit chunks, written to a temporary .wav.
//  On stop: both are joined into the final .mp4 (picture copied, sound to AAC), lined up by the moment
//  ffmpeg opened the screen, then checked with ffprobe. Nothing is reported as saved until that check passes.
//  Start on Space: the picture and sound run from the moment the snip is armed, so nothing is missed while
//  ffmpeg warms up; on stop, the part before the Space press (and after the second one) is cut off exactly.
//  A cut that doesn't fall on a keyframe needs the picture encoded again, once, from the cut point.
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const RATE = 48000, CH = 2;

function unpacked(p) { return p && p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
function ffmpegPath() { return process.env.SNIPZO_FFMPEG || unpacked(require('ffmpeg-static')); }
function ffprobePath() { return process.env.SNIPZO_FFPROBE || unpacked(require('ffprobe-static').path); }

function run(bin, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: String(stderr || ''), err });
    });
  });
}

// ---------- encoders ----------
const ENCODERS = IS_MAC ? [
  { id: 'h264_videotoolbox', name: 'Apple VideoToolbox', gpu: true },
  { id: 'libx264', name: 'CPU (x264)', gpu: false },
] : [
  { id: 'h264_nvenc', name: 'NVIDIA (NVENC)', gpu: true },
  { id: 'h264_amf', name: 'AMD (AMF)', gpu: true },
  { id: 'h264_qsv', name: 'Intel Quick Sync', gpu: false },
  { id: 'libx264', name: 'CPU (x264)', gpu: false },
];
// Tries a tiny real encode with each one; returns the list with ok/why. Run live, never cached across checks.
async function checkEncoders() {
  const out = [];
  for (const e of ENCODERS) {
    const r = await run(ffmpegPath(), ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30:d=0.2',
      '-pix_fmt', e.id === 'h264_qsv' ? 'nv12' : 'yuv420p', '-c:v', e.id, '-f', 'null', '-'], { timeout: 15000 });
    out.push({ ...e, ok: r.code === 0, why: r.code === 0 ? '' : (r.stderr.trim().split(/\r?\n/).pop() || 'not available') });
  }
  return out;
}

function encoderArgs(id, quality, fps, again = false, px = 1920 * 1080) {
  const hi = quality !== 'small';
  if (id === 'h264_videotoolbox') { // bitrate from the size (VideoToolbox's constant quality is Apple-silicon-only)
    const bps = Math.round(px * fps * (hi ? 0.1 : 0.05) * (again ? 1.3 : 1));
    return { cpu: true, pix: 'yuv420p', args: ['-c:v', 'h264_videotoolbox', '-b:v', String(Math.max(2e6, bps)), '-profile:v', 'high', '-allow_sw', '0', '-g', String(fps * 2)] };
  }
  if (again) { // encoding a second time (after a cut): a little better than the first pass, so it loses nothing you'd see
    const q = (a, b) => String((hi ? a : b) - 3);
    switch (id) {
      case 'h264_nvenc': return { cpu: false, pix: 'yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q(21, 28), '-b:v', '0', '-profile:v', 'high', '-g', String(fps * 2)] };
      case 'h264_amf': return { cpu: false, pix: 'yuv420p', args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', q(20, 28), '-qp_p', q(22, 30), '-g', String(fps * 2)] };
      case 'h264_qsv': return { cpu: true, pix: 'nv12', args: ['-c:v', 'h264_qsv', '-global_quality', q(22, 29), '-g', String(fps * 2)] };
      default: return { cpu: true, pix: 'yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', q(20, 27), '-g', String(fps * 2)] };
    }
  }
  const gop = String(fps * 2); // a keyframe every 2 s keeps trimming quick and exact
  switch (id) {
    case 'h264_nvenc': return { cpu: false, args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', hi ? '21' : '28', '-b:v', '0', '-profile:v', 'high', '-g', gop] };
    case 'h264_amf': return { cpu: false, args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', hi ? '20' : '28', '-qp_p', hi ? '22' : '30', '-g', gop] };
    case 'h264_qsv': return { cpu: true, pix: 'nv12', args: ['-c:v', 'h264_qsv', '-global_quality', hi ? '22' : '29', '-g', gop] };
    default: return { cpu: true, pix: 'yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', hi ? '20' : '27', '-g', gop] };
  }
}

// ---------- wav ----------
class Wav {
  constructor(file) { this.file = file; this.fd = fs.openSync(file, 'w'); fs.writeSync(this.fd, Buffer.alloc(44)); this.bytes = 0; }
  write(buf) { fs.writeSync(this.fd, buf); this.bytes += buf.length; }
  close() {
    if (this.fd == null) return;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + this.bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(CH, 22); h.writeUInt32LE(RATE, 24);
    h.writeUInt32LE(RATE * CH * 2, 28); h.writeUInt16LE(CH * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(this.bytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0); fs.closeSync(this.fd); this.fd = null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
function stampName(d = new Date()) {
  return `Snipzo ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
function uniqueFile(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let k = 2; fs.existsSync(p); k++) p = path.join(dir, `${base} (${k})${ext}`);
  return p;
}
async function freeBytes(dir) {
  try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// ---------- one recording ----------
// opts: { adapter, output, rect: {x,y,w,h} physical relative to the monitor, fps, cursor, quality, encoder,
//         audio: bool (sound chunks will arrive), saveDir, log(fn), dev: { display: ':99', x, y } (Linux testing) }
class Recording extends EventEmitter {
  constructor(opts) {
    super();
    this.o = opts;
    this.state = 'starting'; // starting -> recording -> stopping -> done | failed
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snipzo-'));
    this.videoFile = path.join(this.tmp, 'video.mkv');
    this.wav = opts.audio ? new Wav(path.join(this.tmp, 'audio.wav')) : null;
    this.audioFrames = 0; this.audioStart = null; // estimated performance.now() of the first sound sample
    this.videoStart = null; this.stderr = ''; this.stopAsked = false;
  }

  log(s) { try { this.o.log && this.o.log(s); } catch { /* ignore */ } }

  args() {
    const o = this.o, r = o.rect, enc = encoderArgs(o.encoder, o.quality, o.fps, false, r.w * r.h);
    const a = ['-hide_banner', '-nostats', '-v', 'verbose'];
    if (o.dev) {
      a.push('-f', 'x11grab', '-framerate', String(o.fps), '-draw_mouse', o.cursor ? '1' : '0', '-video_size', `${r.w}x${r.h}`, '-i', `${o.dev.display}+${o.dev.x + r.x},${o.dev.y + r.y}`);
      a.push('-pix_fmt', 'yuv420p', ...encoderArgs('libx264', o.quality, o.fps).args);
    } else if (o.mac) {
      // The whole screen at its real pixels, then cropped exactly (bgr0, so an odd x/y doesn't shift by a pixel)
      a.push('-f', 'avfoundation', '-capture_cursor', o.cursor ? '1' : '0', '-framerate', String(o.fps), '-pixel_format', 'bgr0', '-i', `${o.mac.device}:none`);
      a.push('-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y}:exact=1,format=${enc.pix || 'yuv420p'}`, ...enc.args);
    } else {
      // ffmpeg 6.1's ddagrab fails ("Invalid output duplication argument") when it is handed a device, so the
      // first graphics card (where ddagrab looks by itself) gets none; other cards need the device named
      if (o.adapter) a.push('-init_hw_device', `d3d11va=snz:${o.adapter}`, '-filter_hw_device', 'snz');
      let g = `ddagrab=output_idx=${o.output}:framerate=${o.fps}:draw_mouse=${o.cursor ? 1 : 0}:offset_x=${r.x}:offset_y=${r.y}:video_size=${r.w}x${r.h}`;
      if (enc.cpu) g += `,hwdownload,format=bgra,format=${enc.pix}`;
      a.push('-filter_complex', g + '[v]', '-map', '[v]', ...enc.args);
    }
    // Constant frame rate: gaps (the encoder starting up, a dropped frame) are filled by repeating the last
    // frame, so the timing stays true and editors like After Effects get a steady rate
    a.push('-fps_mode', 'cfr', '-r', String(o.fps));
    a.push('-y', this.videoFile);
    return a;
  }

  start() {
    const args = this.args();
    this.log('ffmpeg ' + args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '));
    this.proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const startMark = this.o.dev ? /Input #0, x11grab.*\n.*start: [\d.]+/ : this.o.mac ? /Input #0, avfoundation/ : /Opened dxgi output/;
    this.proc.stderr.on('data', (d) => {
      const s = d.toString();
      if (this.stderr.length < 400000) this.stderr += s;
      if (this.videoStart == null && startMark.test(this.stderr)) {
        // x11grab (Linux testing) prints the wall-clock time of its first frame; ddagrab doesn't, so on Windows
        // the moment it opens the screen is used, corrected by the measured sync (settings: Check sound sync)
        const m = this.o.dev && /start: (\d+\.\d+)/.exec(this.stderr);
        this.videoStart = m ? Number(m[1]) * 1000 - performance.timeOrigin : performance.now();
        this.state = 'recording';
        this.emit('started', { at: Date.now() });
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (e) => { this.stderr += '\n' + e.message; resolve(-1); });
      this.proc.on('exit', (code) => resolve(code == null ? -1 : code));
    });
    this.exited.then((code) => {
      if (!this.stopAsked) { this.log(`ffmpeg ended by itself (code ${code}); its last lines:\n${this.stderr.split(/\r?\n/).slice(-30).join('\n')}`); this.emit('died', { code, why: this.why() }); }
    });
    this.startTimer = setTimeout(() => { if (this.videoStart == null && !this.stopAsked) { this.log('ffmpeg did not start in 10 s'); this.emit('died', { code: -1, why: 'The screen grab did not start within 10 seconds.' }); } }, 10000);
  }

  // A chunk of 16-bit stereo sound: frames = samples per channel, arrived = performance.now() when it came in
  audioChunk(buf, frames, arrived) {
    if (!this.wav || this.state === 'done' || this.state === 'failed') return;
    if (this.wav.fd == null) return;
    this.wav.write(buf);
    this.audioFrames += frames;
    // When did sample 0 happen? Each chunk says "no later than arrival minus everything so far";
    // the earliest of those is the best guess (delivery delays only ever make it later).
    const est = arrived - (this.audioFrames / RATE) * 1000;
    if (this.audioStart == null || est < this.audioStart) this.audioStart = est;
  }

  bytesSoFar() {
    let n = 0; try { n += fs.statSync(this.videoFile).size; } catch { /* not yet */ }
    if (this.wav) n += this.wav.bytes;
    return n;
  }

  why() {
    const lines = this.stderr.split(/\r?\n/).filter((l) => /error|failed|denied|not supported|invalid|cannot|could not/i.test(l));
    const last = lines.slice(-3).join(' ').trim();
    if (IS_MAC && /not authorized|permission|denied/i.test(this.stderr)) return 'macOS refused the screen grab: allow Snipzo in System Settings > Privacy & Security > Screen Recording.';
    if (/access denied/i.test(this.stderr)) return 'Windows refused the screen grab (Desktop duplication access denied). This happens on the lock screen and some secure windows.';
    return last || 'ffmpeg stopped without saying why.';
  }

  async stop() {
    if (this.stopAsked) return this.exited;
    this.stopAsked = true; this.state = 'stopping'; clearTimeout(this.startTimer);
    try { this.proc.stdin.write('q'); this.proc.stdin.end(); } catch { /* already gone */ }
    const killer = setTimeout(() => { try { this.proc.kill(); } catch { /* ignore */ } }, 8000);
    const code = await this.exited; clearTimeout(killer);
    if (this.wav) this.wav.close();
    return code;
  }

  // Seconds into the picture of a performance.now() moment (corrected the same way the sound is lined up)
  pictureTime(at) { return this.videoStart == null ? null : (at - this.videoStart - (this.o.syncMs || 0)) / 1000; }

  // Join, check, move into place. Returns { ok, file, info, why, kept }
  // cut (Start on Space): { from: s, to: s|null } in picture seconds; everything outside is left out.
  async finish(saveDir, cut = null) {
    const ff = ffmpegPath();
    if (!fs.existsSync(this.videoFile) || fs.statSync(this.videoFile).size < 1024 || this.videoStart == null) {
      this.state = 'failed';
      return { ok: false, why: this.why(), kept: this.keep() };
    }
    await fsp.mkdir(saveDir, { recursive: true });
    const out = uniqueFile(saveDir, stampName(new Date(Date.now())), '.mp4');
    const part = out + '.part';
    const from = cut ? Math.max(0, cut.from || 0) : 0;
    const len = cut && cut.to != null ? Math.max(0.1, cut.to - from) : null;
    const recode = from > 0.0005; // a cut inside the picture: encode it again from that frame
    const withSound = this.wav && this.audioFrames > 0;
    // seconds of sound captured before the first kept picture, plus the measured correction
    const offset = withSound ? (this.videoStart - this.audioStart) / 1000 + (this.o.syncMs || 0) / 1000 + from : 0;
    const mk = (encId) => {
      const args = ['-hide_banner', '-v', 'error'];
      if (recode) args.push('-ss', from.toFixed(4)); // before -i and encoded again: exact to the frame
      args.push('-i', this.videoFile);
      if (withSound) {
        // Sound that started early is cut; sound that started late gets real silence in front, so both tracks
        // start at 0 (a delayed track start trips up some players and After Effects)
        if (offset >= 0) args.push('-ss', offset.toFixed(4), '-i', this.wav.file);
        else args.push('-i', this.wav.file);
        args.push('-map', '0:v:0', '-map', '1:a:0', ...this.videoCodec(recode, encId));
        if (offset < 0) args.push('-af', `adelay=delays=${Math.round(-offset * 1000)}:all=1`);
        args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
      } else {
        args.push('-map', '0:v:0', ...this.videoCodec(recode, encId));
      }
      if (len != null) args.push('-t', len.toFixed(4));
      args.push('-movflags', '+faststart', '-metadata', 'comment=snipzo/1', '-f', 'mp4', '-y', part);
      return args;
    };
    const enc = this.o.dev ? 'libx264' : this.o.encoder;
    const args = mk(enc);
    this.log(`join: sound offset ${offset.toFixed(3)} s${cut ? `, cut ${from.toFixed(3)}-${len != null ? (from + len).toFixed(3) : 'end'} s` : ''}; ffmpeg ${args.join(' ')}`);
    let r = await run(ff, args, { timeout: 10 * 60000 });
    if (r.code !== 0 && recode && enc !== 'libx264') { // the graphics card refused the second pass: the CPU does it
      this.log(`second pass with ${enc} failed (${r.stderr.trim().split(/\r?\n/).pop()}); trying x264`);
      r = await run(ff, mk('libx264'), { timeout: 10 * 60000 });
      if (r.code === 0) this.secondPass = 'CPU (x264)';
    }
    if (r.code !== 0 || !fs.existsSync(part)) {
      this.state = 'failed';
      await fsp.unlink(part).catch(() => {});
      return { ok: false, why: 'Joining picture and sound failed: ' + (r.stderr.trim().split(/\r?\n/).pop() || 'unknown error'), kept: this.keep() };
    }
    const info = await probe(part);
    const expectW = this.o.rect.w, expectH = this.o.rect.h;
    const problems = [];
    if (!info || !info.video) problems.push('the saved file has no picture');
    else if (info.video.width !== expectW || info.video.height !== expectH) problems.push(`the picture is ${info.video.width} × ${info.video.height}, not ${expectW} × ${expectH}`);
    if (!info || !(info.duration > 0)) problems.push('the saved file has no length');
    if (withSound && info && !info.audio) problems.push('the sound did not make it into the file');
    if (len != null && info && info.duration > 0 && Math.abs(info.duration - len) > 0.25) problems.push(`it is ${info.duration.toFixed(1)} s long, not the ${len.toFixed(1)} s between the two Space presses`);
    if (problems.length) {
      this.state = 'failed';
      await fsp.rename(part, out).catch(() => {});
      return { ok: false, file: fs.existsSync(out) ? out : null, why: 'The saved file failed its check: ' + problems.join('; ') + '.', kept: this.keep() };
    }
    await fsp.rename(part, out);
    info.file = out; info.sound = !!info.audio;
    this.state = 'done';
    await fsp.rm(this.tmp, { recursive: true, force: true }).catch(() => {}); // our own temporary files only
    return { ok: true, file: out, info };
  }

  // Copy the picture as it is, or (after a cut) encode it again with the same encoder
  videoCodec(recode, encId) {
    if (!recode) return ['-c:v', 'copy'];
    const e = encoderArgs(encId, this.o.quality, this.o.fps, true, this.o.rect.w * this.o.rect.h);
    return ['-pix_fmt', e.pix || 'yuv420p', ...e.args, '-fps_mode', 'cfr', '-r', String(this.o.fps)];
  }

  keep() { return this.tmp; } // on failure the raw recording stays here so nothing is lost

  async discardTemp() { await fsp.rm(this.tmp, { recursive: true, force: true }).catch(() => {}); }
}

async function probe(file) {
  const r = await run(ffprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration,size', '-of', 'json', file], { timeout: 30000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout.toString());
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const fr = v && v.avg_frame_rate ? v.avg_frame_rate.split('/').map(Number) : null;
    return {
      duration: Number(j.format && j.format.duration) || 0,
      size: Number(j.format && j.format.size) || (fs.existsSync(file) ? fs.statSync(file).size : 0),
      video: v ? { width: v.width, height: v.height, fps: fr && fr[1] ? Math.round((fr[0] / fr[1]) * 100) / 100 : null, codec: v.codec_name, pix: v.pix_fmt } : null,
      audio: a ? { codec: a.codec_name } : null,
    };
  } catch { return null; }
}

// One frame from the middle as a JPEG data URL, for the done card
async function thumbnail(file, duration) {
  const t = Math.max(0, (duration || 0) / 2);
  const r = await run(ffmpegPath(), ['-hide_banner', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { timeout: 20000 });
  return r.code === 0 && r.stdout.length ? 'data:image/jpeg;base64,' + r.stdout.toString('base64') : null;
}

// Mac: avfoundation lists cameras first, then "Capture screen 0, 1, …" (in CGGetActiveDisplayList order).
// Returns [{ device, screen }] so screen k is recorded with -i "<device>:none".
async function macScreens() {
  const r = await run(ffmpegPath(), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 15000 });
  const out = [];
  for (const m of r.stderr.matchAll(/\[(\d+)\] Capture screen (\d+)/g)) out.push({ device: Number(m[1]), screen: Number(m[2]) });
  return out;
}

module.exports = { macScreens, Recording, checkEncoders, ENCODERS, probe, thumbnail, freeBytes, stampName, ffmpegPath, ffprobePath, RATE, CH };

// ---------- sound sync check ----------
// The file holds a test window that flashed white and beeped at the same moment, a few times.
// Returns { pairs: [{ flash, beep }], soundLateMs } (median of beep - flash), or { why }.
async function measureSync(file) {
  const ff = ffmpegPath(), fp = ffprobePath();
  const pts = await run(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', file], { timeout: 60000 });
  const times = pts.stdout.toString().trim().split(/\r?\n/).map((l) => Number(l.split(',').find((x) => x && x !== 'N/A')));
  const luma = await run(ff, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'], { timeout: 60000 });
  const flashes = [];
  for (let f = 0, prev = 0; f * 64 < luma.stdout.length; f++) {
    let s = 0; for (let i = 0; i < 64; i++) s += luma.stdout[f * 64 + i];
    const v = s / 64; if (v > 128 && prev <= 128 && Number.isFinite(times[f])) flashes.push(times[f]); prev = v;
  }
  const astart = await run(fp, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file]);
  const a0 = Number(astart.stdout.toString().trim()) || 0;
  const pcm = await run(ff, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { timeout: 60000 });
  const beeps = []; let quiet = 0;
  for (let i = 0; i < pcm.stdout.length / 2; i++) {
    const v = Math.abs(pcm.stdout.readInt16LE(i * 2));
    if (v > 2500) { if (quiet > 4800) beeps.push(a0 + i / 48000); quiet = 0; } else quiet++;
  }
  if (!flashes.length) return { why: "the test window's flashes weren't in the recording" };
  if (!beeps.length) return { why: "the test beeps weren't in the recording (is the PC's sound muted, or playing through a device Windows doesn't treat as the default?)" };
  const pairs = [];
  for (const fl of flashes) { const b = beeps.reduce((best, x) => (Math.abs(x - fl) < Math.abs(best - fl) ? x : best), Infinity); if (Math.abs(b - fl) < 0.6) pairs.push({ flash: fl, beep: b }); }
  if (pairs.length < 2) return { why: 'not enough flashes and beeps matched up to be sure', flashes, beeps };
  const d = pairs.map((p) => (p.beep - p.flash) * 1000).sort((x, y) => x - y);
  return { pairs, soundLateMs: Math.round(d[Math.floor(d.length / 2)]) };
}
module.exports.measureSync = measureSync;
