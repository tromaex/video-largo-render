// video-largo-render: renders long-form videos (narration + scenes + sfx + music + look) with ffmpeg.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA || '/data';
const THREADS = process.env.FF_THREADS || '3';
const LIB = require('./library.json');
const W = 1920, H = 1080, FPS = 30;
const FONTDIR = ['/app/fonts', '/usr/share/fonts/truetype/anton'].find(d => fs.existsSync(path.join(d, 'Anton-Regular.ttf')));
const FONT = FONTDIR ? path.join(FONTDIR, 'Anton-Regular.ttf') : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const PUBLIC = (process.env.PUBLIC_URL || 'https://video.licjuanpablo.com.ar').replace(/\/$/, '');
for (const d of ['cache', 'jobs', 'lib', 'pub']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const jobs = new Map();
const queue = [];
let busy = false;

function log(job, msg) { const l = `[${new Date().toISOString()}] ${msg}`; job.log.push(l); if (job.log.length > 200) job.log.shift(); console.log(job.id, msg); }

function run(cmd, args, job) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('close', c => c === 0 ? res() : rej(new Error(`${cmd} exit ${c}: ${err.slice(-1500)}`)));
  });
}
function runErr(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on('close', c => c === 0 ? res(err) : rej(new Error(`${cmd} exit ${c}: ${err.slice(-1500)}`)));
  });
}
// v3: tratamiento de voz tipo Audacity, gratis con ffmpeg (highpass + afftdn + de-esser + compresor + loudnorm 2 pasadas)
const VOICE_CHAIN = 'highpass=f=80,afftdn=nr=11:nf=-25:tn=1,deesser=i=0.25:m=0.5:f=0.5:s=o,acompressor=threshold=-18dB:ratio=3:attack=15:release=200:knee=4';
async function prepVoice(job, src, v, D, dir) {
  const out = path.join(dir, 'voice.wav');
  const cut = +v.cut > 0 ? +v.cut : 0;
  const inA = ['-y', '-v', 'info', '-nostats', ...(cut ? ['-t', String(cut)] : []), '-i', src, '-vn'];
  const pad = Math.max(0, +v.pad_start || 0);
  const tail = (cut ? `,afade=t=out:st=${Math.max(0, cut - 0.4).toFixed(2)}:d=0.4` : '') + `,adelay=${Math.round(pad * 1000)}:all=1,apad=whole_dur=${(D || 0).toFixed(3)}`;
  if (v.enhance !== false) {
    try {
      const L = v.loudnorm || { I: -16, TP: -1.5, LRA: 11 };
      const chain = (v.chain || VOICE_CHAIN);
      const e1 = await runErr('ffmpeg', [...inA, '-af', `aresample=48000,${chain},loudnorm=I=${L.I}:TP=${L.TP}:LRA=${L.LRA}:print_format=json`, '-f', 'null', '-']);
      const js = JSON.parse(e1.slice(e1.lastIndexOf('{'), e1.lastIndexOf('}') + 1));
      const ln = `loudnorm=I=${L.I}:TP=${L.TP}:LRA=${L.LRA}:measured_I=${js.input_i}:measured_TP=${js.input_tp}:measured_LRA=${js.input_lra}:measured_thresh=${js.input_thresh}:offset=${js.target_offset}:linear=true`;
      await run('ffmpeg', [...inA, '-af', `aresample=48000,${chain},${ln},aresample=48000${tail}`, '-c:a', 'pcm_s16le', out], job);
      job.voice = { enhanced: true, input_i: +js.input_i, input_tp: +js.input_tp, input_lra: +js.input_lra };
      log(job, `voice enhanced (in ${js.input_i} LUFS, TP ${js.input_tp}) -> ${L.I} LUFS`);
      return out;
    } catch (e) { log(job, 'voice enhance failed, using original: ' + e.message.slice(0, 300)); }
  }
  await run('ffmpeg', [...inA, '-af', `aresample=48000${tail}`, '-c:a', 'pcm_s16le', out], job);
  job.voice = { enhanced: false };
  return out;
}
function pubSave(name) {
  const id = crypto.randomBytes(9).toString('hex');
  const clean = String(name || 'file.bin').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file.bin';
  fs.mkdirSync(path.join(DATA, 'pub', id), { recursive: true });
  return { id, name: clean, file: path.join(DATA, 'pub', id, clean), url: `${PUBLIC}/pub/${id}/${clean}` };
}
function saveBody(req, file) { return new Promise((res, rej) => { const w = fs.createWriteStream(file); req.pipe(w); w.on('finish', res); w.on('error', rej); req.on('error', rej); }); }
const MIME = { mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', srt: 'text/plain; charset=utf-8', json: 'application/json' };
function serveFile(req, res, file) {
  const st = fs.statSync(file); const type = MIME[(file.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const r = String(req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  if (r && (r[1] || r[2])) {
    let a = r[1] ? +r[1] : st.size - +r[2], b = r[1] && r[2] ? +r[2] : st.size - 1; b = Math.min(b, st.size - 1);
    if (a > b || a < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).pipe(res);
}
function probeDur(file) {
  return new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let o = ''; p.stdout.on('data', d => o += d); p.on('close', c => c === 0 ? res(parseFloat(o)) : rej(new Error('ffprobe failed ' + file)));
  });
}
function normUrl(u) {
  let m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/open\?id=([\w-]+)/) || u.match(/[?&]id=([\w-]+).*drive/);
  if (m && /drive\.google\.com/.test(u)) return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  return u;
}
function isYT(u) { return /(youtube\.com\/(watch|shorts|live)|youtu\.be\/)/i.test(u); }
async function download(url, job) {
  if (isYT(url)) {
    const key = 'yt_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    const f = path.join(DATA, 'cache', key + '.mp4');
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
    if (job) log(job, 'yt-dlp ' + url);
    const args = ['--no-playlist', '--no-progress', '-f', 'bv*[height<=720][vcodec^=avc1]/bv*[height<=720]/b[height<=720]/b', '--remux-video', 'mp4', '-o', path.join(DATA, 'cache', key + '.%(ext)s'), url];
    if (process.env.YTDLP_EXTRA) args.unshift(...process.env.YTDLP_EXTRA.split(' '));
    await run('yt-dlp', args, job);
    if (!fs.existsSync(f)) { const alt = fs.readdirSync(path.join(DATA, 'cache')).find(n => n.startsWith(key + '.')); if (!alt) throw new Error('yt-dlp: no output'); await fsp.rename(path.join(DATA, 'cache', alt), f); }
    return f;
  }
  if (url.startsWith(PUBLIC + '/pub/')) { const p = path.join(DATA, 'pub', ...url.slice(PUBLIC.length + 5).split('?')[0].split('/').map(decodeURIComponent)); if (!p.includes('..') && fs.existsSync(p)) return p; }
  url = normUrl(url);
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = (url.split('?')[0].match(/\.(mp3|mp4|m4a|wav|webm|mov|mkv|png|jpg|jpeg)$/i) || [, 'bin'])[1];
  const f = path.join(DATA, 'cache', key + '.' + ext);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  if (job) log(job, 'download ' + url.slice(0, 120));
  await run('curl', ['-sSL', '--fail', '--retry', '3', '-A', 'Mozilla/5.0', '-o', f + '.part', url]);
  await fsp.rename(f + '.part', f);
  return f;
}
function libUrl(group, key) { const e = LIB[group][key]; if (!e) throw new Error(`unknown ${group} key ${key}`); return e.url; }

function esc(t) { return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%'); }

// v2: transición de entrada por escena (los primeros ~0.3 s), sin tocar el resto de la toma
function transFilter(tr) {
  const e = (d) => `enable='lt(t,${d})'`;
  switch (tr) {
    case 'flash': return `fade=t=in:st=0:d=0.22:color=white`;
    case 'dip': return `fade=t=in:st=0:d=0.3:color=black`;
    case 'glitch': return `rgbashift=rh=-14:bh=14:gv=4:${e(0.3)},noise=alls=45:allf=t:${e(0.3)}`;
    case 'whip': return `avgblur=sizeX=70:sizeY=1:${e(0.16)},avgblur=sizeX=30:sizeY=1:${e(0.26)}`;
    case 'leak': return `colorchannelmixer=rr=1.35:gg=1.12:bb=0.78:${e(0.35)},eq=brightness=0.22:saturation=1.3:${e(0.25)}`;
    case 'burn': return `eq=brightness=0.45:contrast=1.4:${e(0.12)},colorchannelmixer=rr=1.5:gg=1.0:bb=0.5:${e(0.3)}`;
    case 'zoom': return `scale=w='iw*(1+0.25*max(0,1-t/0.3))':h='ih*(1+0.25*max(0,1-t/0.3))':eval=frame,crop=${W}:${H}`;
    default: return '';
  }
}
function effectFilter(effect, frames) {
  const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  const N = Math.max(frames, 2);
  switch (effect) {
    case 'zoom_in': return `scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,crop=${W * 1.5}:${H * 1.5},zoompan=z='1+0.14*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1`;
    case 'zoom_out': return `scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,crop=${W * 1.5}:${H * 1.5},zoompan=z='1.14-0.14*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1`;
    case 'punch': return `scale=${W * 1.18}:${H * 1.18}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    case 'shake': return `scale=${W + 96}:${H + 54}:force_original_aspect_ratio=increase,crop=${W}:${H}:x='48+22*sin(n*1.7)+10*sin(n*4.1)':y='27+14*sin(n*2.3)',setsar=1`;
    case 'pan': return `scale=${Math.round(W * 1.2)}:${Math.round(H * 1.2)}:force_original_aspect_ratio=increase,crop=${W}:${H}:x='(iw-ow)*n/${N}':y='(ih-oh)/2',setsar=1`;
    case 'glitch': return `${base},rgbashift=rh=-8:bh=8:gv=3,noise=alls=30:allf=t`;
    default: return base;
  }
}

async function renderScene(job, s, i, dir) {
  const dur = Math.max(0.2, s.end - s.start);
  const frames = Math.round(dur * FPS);
  const out = path.join(dir, `s${String(i).padStart(4, '0')}.mp4`);
  const src = s.source || { type: 'color' };
  let inArgs;
  if (src.type === 'color' || !src.url) inArgs = ['-f', 'lavfi', '-i', `color=c=${src.color || 'black'}:s=${W}x${H}:r=${FPS}`];
  else {
    const f = await download(src.url, job);
    if (/\.(png|jpe?g)$/i.test(f)) inArgs = ['-loop', '1', '-framerate', String(FPS), '-i', f];
    else inArgs = ['-stream_loop', '-1', '-ss', String(src.offset || 0), '-i', f];
  }
  const c = Math.min(0.3, Math.max(0, +src.crop || 0));
  let vf = `fps=${FPS},` + (c ? `crop=iw*${(1 - c).toFixed(3)}:ih*${(1 - c).toFixed(3)},` : '') + effectFilter(s.effect, frames);
  if (s.text) {
    const pos = s.text_pos === 'center' ? `x=(w-text_w)/2:y=(h-text_h)/2` : `x=(w-text_w)/2:y=h-text_h-230`;
    const size = s.text_size || (s.text_pos === 'center' ? 92 : 58);
    vf += `,drawtext=fontfile=${FONT}:text='${esc(s.text)}':fontsize=${size}:fontcolor=${s.text_color || '0xFFD600'}:borderw=5:bordercolor=0x0B0B0B@0.9:${pos}:alpha='min(1,t/0.3)'`;
  }
  if (s.trans_in) { const tf = transFilter(s.trans_in); if (tf) vf += ',' + tf; }
  if (s.fade_in) vf += `,fade=t=in:st=0:d=${Math.min(0.6, dur / 3)}`;
  if (s.fade_out) vf += `,fade=t=out:st=${Math.max(0, dur - Math.min(0.6, dur / 3))}:d=${Math.min(0.6, dur / 3)}`;
  vf += ',format=yuv420p';
  await run('ffmpeg', ['-y', '-v', 'error', ...inArgs, '-t', dur.toFixed(3), '-vf', vf, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', String(FPS), '-threads', THREADS, out], job);
  return out;
}

async function processJob(job) {
  const spec = job.spec;
  const dir = path.join(DATA, 'jobs', job.id);
  await fsp.mkdir(dir, { recursive: true });
  job.status = 'downloading';
  const narrSrc = await download(spec.audio_url, job);
  let narr = narrSrc;
  let D = spec.duration;
  if (spec.voice) {
    if (!D) D = (+spec.voice.cut > 0 ? +spec.voice.cut : await probeDur(narrSrc)) + (+spec.voice.pad_start || 0) + (+spec.voice.pad_end || 0);
    job.status = 'voice';
    narr = await prepVoice(job, narrSrc, spec.voice, D, dir);
  }
  if (!D) D = await probeDur(narr);
  job.duration = D;
  log(job, `narration ${D.toFixed(1)}s, ${spec.scenes.length} scenes`);
  // fill gaps so scenes cover [0,D]
  let scenes = [...spec.scenes].sort((a, b) => a.start - b.start);
  const filled = []; let t = 0;
  for (const s of scenes) {
    if (s.start > t + 0.05) filled.push({ start: t, end: s.start, source: filled.length ? filled[filled.length - 1].source : { type: 'color' }, effect: 'none' });
    const st = Math.max(s.start, t); const en = Math.min(s.end, D);
    if (en > st + 0.05) filled.push({ ...s, start: st, end: en });
    t = Math.max(t, en);
  }
  if (t < D - 0.05) filled.push({ start: t, end: D, source: filled.length ? filled[filled.length - 1].source : { type: 'color' }, effect: 'none', fade_out: true });
  job.status = 'rendering_scenes'; job.total = filled.length; job.done = 0;
  const list = [];
  for (let i = 0; i < filled.length; i++) {
    try { list.push(await renderScene(job, filled[i], i, dir)); }
    catch (e) {
      log(job, `scene ${i} failed (${e.message.slice(0, 300)})`);
      let ok = false;
      const tries = [{ ...filled[i], effect: 'none', trans_in: null, source: { ...(filled[i].source || {}), offset: 0 } }];
      for (let k = i - 1; k >= 0 && tries.length < 3; k--) if (filled[k].source && filled[k].source.url && filled[k].source.type !== 'color') tries.push({ ...filled[i], effect: 'zoom_in', trans_in: null, source: { ...filled[k].source, offset: (filled[k].source.offset || 0) + (filled[k].end - filled[k].start) } });
      for (const t of tries) { try { list.push(await renderScene(job, t, i, dir)); ok = true; break; } catch (e2) {} }
      if (!ok) { log(job, `scene ${i} using black`); list.push(await renderScene(job, { ...filled[i], source: { type: 'color' }, effect: 'none', trans_in: null, text: null }, i, dir)); }
    }
    job.done = i + 1;
  }
  await fsp.writeFile(path.join(dir, 'list.txt'), list.map(f => `file '${f}'`).join('\n'));
  const video = path.join(dir, 'video.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c', 'copy', video], job);

  job.status = 'mixing';
  const inputs = ['-i', video, '-i', narr];
  const fc = []; const mixA = ['[nar]']; let idx = 2;
  fc.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${spec.narration_volume || 1.0},asplit=2[nar][sc]`);
  const musLabels = [];
  for (const [j, m] of (spec.music || []).entries()) {
    const f = await download(m.url || libUrl('music', m.key), job);
    inputs.push('-stream_loop', '-1', '-i', f);
    const dur = Math.max(1, Math.min(m.end ?? D, D) - m.start);
    const fi = Math.min(2, dur / 4), fo = Math.min(3, dur / 4);
    fc.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=${fi}:curve=tri,afade=t=out:st=${(dur - fo).toFixed(2)}:d=${fo},volume=${m.vol ?? 0.22},adelay=${Math.round(m.start * 1000)}:all=1[m${j}]`);
    musLabels.push(`[m${j}]`); idx++;
  }
  if (musLabels.length) {
    fc.push(`${musLabels.join('')}amix=inputs=${musLabels.length}:normalize=0:duration=longest[mus]`);
    const dk = spec.ducking || {};
    fc.push(`[mus][sc]sidechaincompress=threshold=${dk.threshold ?? 0.02}:ratio=${dk.ratio ?? 6}:attack=${dk.attack ?? 30}:release=${dk.release ?? 600}:makeup=1[musd]`);
    mixA.push('[musd]');
  } else fc.push('[sc]anullsink');
  for (const [j, s] of (spec.sfx || []).entries()) {
    try {
      const f = await download(s.url || libUrl('sfx', s.key), job);
      inputs.push('-i', f);
      let chain = `[${idx}:a]aresample=48000,aformat=channel_layouts=stereo`;
      if (s.dur) chain += `,atrim=0:${s.dur},afade=t=out:st=${Math.max(0, s.dur - 0.4)}:d=0.4`;
      chain += `,volume=${s.vol ?? 0.6},adelay=${Math.round(s.at * 1000)}:all=1[x${j}]`;
      fc.push(chain); mixA.push(`[x${j}]`); idx++;
    } catch (e) { log(job, `sfx ${s.key} skipped: ${e.message.slice(0, 200)}`); }
  }
  fc.push(`${mixA.join('')}amix=inputs=${mixA.length}:normalize=0:duration=first,alimiter=limit=0.95[aout]`);
  const look = spec.look || { grain: true, vignette: true };
  const vf = ['[0:v]null'];
  if (look.vhs) vf.push('rgbashift=rh=-2:bh=2', 'eq=saturation=0.85:contrast=1.05');
  if (look.desaturate) vf.push(`eq=saturation=${look.desaturate}`);
  if (look.grain) vf.push(`noise=alls=${look.grain === true ? 5 : look.grain}:allf=t`);
  if (look.vignette) vf.push('vignette=PI/5');
  if (spec.subtitles && spec.subtitles.srt && spec.subtitles.burn !== false) {
    const sf = path.join(dir, 'subs.srt'); await fsp.writeFile(sf, String(spec.subtitles.srt));
    const st = spec.subtitles.style || 'FontName=Anton,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H000B0B0B,BorderStyle=1,Outline=2.2,Shadow=0,MarginV=38,Alignment=2';
    vf.push(`subtitles='${sf.replace(/'/g, "")}':fontsdir=${FONTDIR || '/usr/share/fonts'}:force_style='${st}'`);
  }
  fc.push(vf.join(',') + ',format=yuv420p[vout]');
  const out = path.join(dir, 'final.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', D.toFixed(3),
    '-c:v', 'libx264', '-preset', spec.preset || 'veryfast', '-crf', String(spec.crf || 22), '-maxrate', '10M', '-bufsize', '20M', '-threads', THREADS, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], job);
  for (const f of list) await fsp.unlink(f).catch(() => {});
  await fsp.unlink(video).catch(() => {});
  if (narr !== narrSrc) await fsp.unlink(narr).catch(() => {});
  job.file = out; job.size = fs.statSync(out).size;
  log(job, `rendered ${(job.size / 1e6).toFixed(1)} MB`);

  if (spec.upload_url) {
    job.status = 'uploading';
    const r = await fetch(spec.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(job.size) }, body: fs.createReadStream(out), duplex: 'half' });
    const txt = await r.text();
    if (!r.ok) throw new Error(`upload HTTP ${r.status}: ${txt.slice(0, 500)}`);
    try { job.youtube = JSON.parse(txt); } catch { job.youtube = { raw: txt.slice(0, 500) }; }
    log(job, 'uploaded ' + (job.youtube.id || ''));
  }
  job.status = 'done';
}

async function pump() {
  if (busy) return; const job = queue.shift(); if (!job) return; busy = true;
  job.started = Date.now();
  try { await processJob(job); }
  catch (e) { job.status = 'error'; job.error = e.message.slice(0, 2000); log(job, 'ERROR ' + job.error); }
  job.finished = Date.now(); busy = false;
  if (job.spec.callback_url) {
    try { await fetch(job.spec.callback_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pub(job)) }); } catch (e) { console.log('callback failed', e.message); }
  }
  pump();
}
function pub(j) { const { spec, ...r } = j; return { ...r, meta: spec.meta || null, file_url: j.file ? `/files/${j.id}.mp4` : null }; }

async function cleanup() {
  const cutoff = Date.now() - 3 * 864e5;
  for (const sub of ['jobs', 'cache']) {
    for (const n of await fsp.readdir(path.join(DATA, sub)).catch(() => [])) {
      const p = path.join(DATA, sub, n); const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
    }
  }
  // pub: archivos grandes (mp4 de preview/pack) 10 días; miniaturas e imágenes 120 días (A/B diario las necesita)
  for (const n of await fsp.readdir(path.join(DATA, 'pub')).catch(() => [])) {
    const d = path.join(DATA, 'pub', n);
    if (fs.existsSync(path.join(d, '.keep'))) continue;
    for (const f of (await fsp.readdir(d).catch(() => [])).filter(x => x !== '.keep')) {
      const st = await fsp.stat(path.join(d, f)).catch(() => null); if (!st) continue;
      const age = Date.now() - st.mtimeMs;
      if (age > 120 * 864e5 || (st.size > 20e6 && age > 10 * 864e5)) await fsp.rm(d, { recursive: true, force: true });
    }
  }
}
setInterval(cleanup, 6 * 3600e3);

const prefetches = new Map();
async function inspectOne(url) {
  try {
    const f = await download(url);
    const info = await new Promise((r2, j2) => { const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]); let o = ''; p.stdout.on('data', d => o += d); p.on('close', c => c === 0 ? r2(JSON.parse(o)) : j2(new Error('ffprobe'))); });
    const v = (info.streams || []).find(s => s.codec_type === 'video');
    return { url, has_video: !!v, has_audio: (info.streams || []).some(s => s.codec_type === 'audio'), duration: parseFloat(info.format?.duration || 0), width: v?.width || null, height: v?.height || null };
  } catch (e) { return { url, error: e.message.slice(0, 300) }; }
}
function body(req) { return new Promise((res, rej) => { let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, { ok: true, busy, queued: queue.length, jobs: [...jobs.values()].slice(-10).map(j => ({ id: j.id, status: j.status, done: j.done, total: j.total })) });
    let pm;
    if ((req.method === 'GET' || req.method === 'HEAD') && (pm = u.pathname.match(/^\/pub\/([a-f0-9]{18})\/([\w.\-]+)$/))) {
      const f = path.join(DATA, 'pub', pm[1], pm[2]); if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      return serveFile(req, res, f);
    }
    if (process.env.API_KEY && req.headers['x-api-key'] !== process.env.API_KEY && u.searchParams.get('k') !== process.env.API_KEY) return send(res, 401, { error: 'unauthorized' });
    if ((req.method === 'POST' || req.method === 'PUT') && u.pathname === '/upload') {
      // v3: hosting propio (reemplaza fal storage). Body binario -> URL pública /pub/<id>/<name>
      const p = pubSave(u.searchParams.get('name') || 'file.bin'); await saveBody(req, p.file);
      if (u.searchParams.get('keep') === '1') fs.writeFileSync(path.join(path.dirname(p.file), '.keep'), '');
      const size = fs.statSync(p.file).size; if (!size) { fs.rmSync(path.dirname(p.file), { recursive: true, force: true }); return send(res, 400, { error: 'empty body' }); }
      return send(res, 200, { url: p.url, file_url: p.url, size });
    }
    if (req.method === 'POST' && u.pathname === '/frame') {
      // v3: primer cuadro (o ?t=s) de un video binario o {url} -> JPG público (reemplaza fal extract-frame)
      const p = pubSave((u.searchParams.get('name') || 'frame.jpg').replace(/\.\w+$/, '') + '.jpg');
      let src;
      if (/json/.test(req.headers['content-type'] || '')) { const b = await body(req); src = await download(b.url || b.video_url); }
      else { src = path.join(DATA, 'cache', 'frm_' + crypto.randomBytes(6).toString('hex') + '.mp4'); await saveBody(req, src); }
      try { await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(+u.searchParams.get('t') || 0), '-i', src, '-frames:v', '1', '-q:v', '2', p.file]); }
      finally { if (src.includes('frm_')) await fsp.unlink(src).catch(() => {}); }
      return send(res, 200, { url: p.url, images: [{ url: p.url }] });
    }
    if (req.method === 'POST' && (pm = u.pathname.match(/^\/publish\/(\w+)$/))) {
      // v3: link público del mp4 de un job (preview por Telegram, reemplaza la subida a fal)
      const j = jobs.get(pm[1]); if (!j || !j.file || !fs.existsSync(j.file)) return send(res, 404, { error: 'not ready' });
      const p = pubSave((u.searchParams.get('name') || `video-${j.id}`).replace(/\.\w+$/, '') + '.mp4');
      try { fs.linkSync(j.file, p.file); } catch (e) { await fsp.copyFile(j.file, p.file); }
      return send(res, 200, { url: p.url, file_url: p.url, size: fs.statSync(p.file).size });
    }
    if (req.method === 'GET' && u.pathname === '/features') return send(res, 200, { v: 3, voice: 'spec.voice{enhance,cut,pad_start,pad_end,chain,loudnorm}', endpoints: ['PUT|POST /upload?name=', 'POST /frame?name=&t=', 'POST /publish/:job', 'GET /pub/:id/:name (público)'], scene: ['trans_in:flash|dip|glitch|whip|leak|burn|zoom', 'text_color'], spec: ['subtitles{srt,burn,style}', 'ducking{threshold,ratio,attack,release}'] });
    if (req.method === 'GET' && u.pathname === '/library') return send(res, 200, { license: LIB.license, sfx: Object.fromEntries(Object.entries(LIB.sfx).map(([k, v]) => [k, v.desc])), music: Object.fromEntries(Object.entries(LIB.music).map(([k, v]) => [k, v.desc])) });
    if (req.method === 'POST' && u.pathname === '/prep-audio') {
      // returns a small mono mp3 of the narration for transcription (Whisper limit 25 MB)
      const b = await body(req); const f = await download(b.url);
      const out = f + '.whisper.mp3';
      if (!fs.existsSync(out)) await run('ffmpeg', ['-y', '-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out]);
      const d = await probeDur(f);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Duration': String(d), 'Content-Disposition': 'attachment; filename="narracion.mp3"' });
      return fs.createReadStream(out).pipe(res);
    }
    if (req.method === 'POST' && u.pathname === '/prefetch') {
      // async version of /inspect (YouTube downloads outlive Cloudflare's 100 s): {urls} -> {id}; poll GET /prefetch/:id
      const b = await body(req); const id = crypto.randomBytes(6).toString('hex');
      const pf = { id, status: 'running', files: [], created: Date.now() }; prefetches.set(id, pf);
      (async () => { for (const url of b.urls || []) pf.files.push(await inspectOne(url)); pf.status = 'done'; })().catch(e => { pf.status = 'error'; pf.error = e.message; });
      return send(res, 202, { id, poll: `/prefetch/${id}` });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/prefetch/')) { const pf = prefetches.get(u.pathname.split('/')[2]); return pf ? send(res, 200, pf) : send(res, 404, { error: 'not found' }); }
    if (req.method === 'POST' && u.pathname === '/inspect') {
      // {urls:[...]} -> [{url, has_video, has_audio, duration, width, height}]
      const b = await body(req); const out = [];
      for (const url of b.urls || []) {
        try {
          const f = await download(url);
          const info = await new Promise((r2, j2) => { const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]); let o = ''; p.stdout.on('data', d => o += d); p.on('close', c => c === 0 ? r2(JSON.parse(o)) : j2(new Error('ffprobe'))); });
          const v = (info.streams || []).find(s => s.codec_type === 'video');
          out.push({ url, has_video: !!v, has_audio: (info.streams || []).some(s => s.codec_type === 'audio'), duration: parseFloat(info.format?.duration || 0), width: v?.width || null, height: v?.height || null });
        } catch (e) { out.push({ url, error: e.message.slice(0, 200) }); }
      }
      return send(res, 200, { files: out });
    }
    if (req.method === 'POST' && u.pathname === '/jobs') {
      const spec = await body(req);
      if (!spec.audio_url || !Array.isArray(spec.scenes)) return send(res, 400, { error: 'audio_url and scenes[] required' });
      const job = { id: crypto.randomBytes(6).toString('hex'), status: 'queued', created: Date.now(), log: [], spec };
      jobs.set(job.id, job); queue.push(job); pump();
      return send(res, 202, { id: job.id, status: job.status, poll: `/jobs/${job.id}` });
    }
    let m;
    if (req.method === 'GET' && (m = u.pathname.match(/^\/jobs\/(\w+)$/))) { const j = jobs.get(m[1]); return j ? send(res, 200, pub(j)) : send(res, 404, { error: 'not found' }); }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/files\/(\w+)\.mp4$/))) {
      const j = jobs.get(m[1]); if (!j || !j.file) return send(res, 404, { error: 'not ready' });
      const st = fs.statSync(j.file); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size }); return fs.createReadStream(j.file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log('video-largo-render on :' + PORT));
