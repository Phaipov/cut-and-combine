const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const resolveBundledBinary = binaryPath => binaryPath.replace('app.asar', 'app.asar.unpacked');
const ffmpegPath = resolveBundledBinary(require('ffmpeg-static'));
const ffprobePath = resolveBundledBinary(require('ffprobe-static').path);
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;
// app.asar is read-only in the installed desktop app.  Keep temporary work
// files in Electron's writable user-data folder instead.
const workDir = process.env.P_TWO7_DATA_DIR || __dirname;
const uploadDir = path.join(workDir, 'uploads');
const outputDir = path.join(workDir, 'outputs');
const activeJobs = new Map();
const cancelledJobs = new Set();
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.mp4'}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('video/'))
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(outputDir));

function render(command, jobId = '', totalDuration = 0) {
  return new Promise((resolve, reject) => {
    const finish = callback => value => {
      if (jobId && activeJobs.get(jobId)?.command === command) activeJobs.delete(jobId);
      callback(value);
    };
    const fail = error => {
      if (jobId && cancelledJobs.delete(jobId)) error.cancelled = true;
      finish(reject)(error);
    };
    if (jobId) activeJobs.set(jobId, { command, percent: 0 });
    command.on('progress', progress => {
      const job = activeJobs.get(jobId);
      if (!job || !totalDuration) return;
      const seconds = String(progress.timemark || '0').split(':').reduce((value, part) => value * 60 + Number(part), 0);
      if (Number.isFinite(seconds)) job.percent = Math.min(99, Math.max(0, seconds / totalDuration * 100));
    }).on('end', finish(resolve)).on('error', fail).run();
  });
}

function getDuration(file) {
  return new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, metadata) => {
    if (error) return reject(error);
    resolve(Number(metadata.format.duration));
  }));
}

function getVideoCodec(file) {
  return new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, metadata) => {
    if (error) return reject(error);
    resolve(metadata.streams.find(stream => stream.codec_type === 'video')?.codec_name || '');
  }));
}

function getVideoSize(file) {
  return new Promise((resolve, reject) => ffmpeg.ffprobe(file, (error, metadata) => {
    if (error) return reject(error);
    const video = metadata.streams.find(stream => stream.codec_type === 'video');
    resolve({ width: Number(video?.width), height: Number(video?.height) });
  }));
}

function cleanLater(paths) {
  setTimeout(() => paths.forEach(file => fsp.unlink(file).catch(() => {})), 60 * 60 * 1000).unref();
}

async function purgeOldFiles() {
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  for (const dir of [uploadDir, outputDir]) {
    try {
      const files = await fsp.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stats = await fsp.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fsp.unlink(filePath).catch(() => {});
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}
purgeOldFiles();
setInterval(purgeOldFiles, 30 * 60 * 1000).unref();

async function renderFadeCombine(inputPaths, output, fadeDuration, jobId) {
  const durations = await Promise.all(inputPaths.map(getDuration));
  const codecs = await Promise.all(inputPaths.map(getVideoCodec));
  const outputSize = await getVideoSize(inputPaths[0]);
  if (durations.some(duration => !Number.isFinite(duration) || duration <= fadeDuration)) throw new Error('Each video must be longer than the fade duration.');
  const command = ffmpeg();
  const useQsvDecode = codecs.every(codec => codec === 'av1');
  inputPaths.forEach(file => {
    command.input(file);
    if (useQsvDecode) command.inputOptions(['-hwaccel qsv', '-c:v av1_qsv']);
  });
  if (!outputSize.width || !outputSize.height) throw new Error('Video resolution unavailable.');
  const filters = inputPaths.flatMap((_file, index) => [
    `[${index}:v]scale=${outputSize.width}:${outputSize.height}:force_original_aspect_ratio=decrease,pad=${outputSize.width}:${outputSize.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`,
    `[${index}:a]aresample=async=1[a${index}]`
  ]);
  let currentVideo = 'v0';
  let currentAudio = 'a0';
  let elapsed = durations[0];
  for (let index = 1; index < inputPaths.length; index += 1) {
    const nextVideo = `vf${index}`;
    const nextAudio = `af${index}`;
    filters.push(`[${currentVideo}][v${index}]xfade=transition=fade:duration=${fadeDuration}:offset=${Math.max(0, elapsed - fadeDuration).toFixed(3)}[${nextVideo}]`);
    filters.push(`[${currentAudio}][a${index}]acrossfade=d=${fadeDuration}[${nextAudio}]`);
    currentVideo = nextVideo;
    currentAudio = nextAudio;
    elapsed += durations[index] - fadeDuration;
  }
  const filterGraph = command.complexFilter(filters);
  const baseOptions = ['-map [' + currentVideo + ']', '-map [' + currentAudio + ']', '-c:a aac', '-movflags +faststart'];
  // Intel Quick Sync is available on this PC and is much faster than CPU encoding for fades.
  try {
    await render(filterGraph.outputOptions([...baseOptions, '-c:v h264_qsv', '-global_quality 20', '-look_ahead 0', '-async_depth 4']).save(output), jobId, elapsed);
  } catch (error) {
    if (error.cancelled) throw error;
    await fsp.unlink(output).catch(() => {});
    const cpuCommand = ffmpeg();
    inputPaths.forEach(file => cpuCommand.input(file));
    await render(cpuCommand.complexFilter(filters).outputOptions([...baseOptions, '-c:v libx264', '-preset ultrafast', '-tune fastdecode', '-crf 20', '-threads 0']).save(output), jobId, elapsed);
  }
}

app.post('/api/cancel', express.json(), (req, res) => {
  const jobId = String(req.body.jobId || '');
  const command = activeJobs.get(jobId)?.command;
  if (command) cancelledJobs.add(jobId);
  if (command) command.kill('SIGKILL');
  res.json({ cancelled: Boolean(command) });
});

app.get('/api/progress/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  res.json({ active: Boolean(job), percent: job?.percent || 0 });
});

app.post('/api/cut', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a video file.' });
  const parts = Number.parseInt(req.body.parts, 10);
  const jobId = String(req.body.jobId || '');
  if (!Number.isInteger(parts) || parts < 1 || parts > 20) {
    await fsp.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Choose between 1 and 20 video parts.' });
  }
  try {
    const duration = await getDuration(req.file.path);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration unavailable');
    const partDuration = duration / parts;
    const prefix = `split-${crypto.randomUUID()}`;
    const pattern = path.join(outputDir, `${prefix}-%03d.mp4`);
    const outputOptions = ['-map 0:v:0', '-map 0:a?', '-c copy', '-f segment', `-segment_time ${partDuration}`, '-reset_timestamps 1', '-avoid_negative_ts make_zero'];

    // Stream copying cuts without re-encoding, so long videos finish much faster.
    try {
      await render(ffmpeg(req.file.path).outputOptions(outputOptions).save(pattern), jobId);
    } catch (error) {
      if (error.cancelled) throw error;
      // A few uncommon source codecs cannot be copied into MP4. Fall back to one encode pass.
      const partials = await fsp.readdir(outputDir);
      await Promise.all(partials.filter(name => name.startsWith(prefix)).map(name => fsp.unlink(path.join(outputDir, name)).catch(() => {})));
      await render(ffmpeg(req.file.path)
        .outputOptions(['-map 0:v:0', '-map 0:a?', '-c:v libx264', '-preset veryfast', '-crf 23', '-c:a aac', `-force_key_frames expr:gte(t,n_forced*${partDuration})`, '-f segment', `-segment_time ${partDuration}`, '-reset_timestamps 1', '-movflags +faststart'])
        .save(pattern), jobId);
    }
    const outputs = (await fsp.readdir(outputDir))
      .filter(name => name.startsWith(prefix) && name.endsWith('.mp4'))
      .sort()
      .map(name => path.join(outputDir, name));
    if (!outputs.length) throw new Error('No video parts were created');
    cleanLater([req.file.path, ...outputs]);
    res.json({
      files: outputs.map((file, index) => ({
        name: `cut-${index + 1}.mp4`,
        storedName: path.basename(file),
        url: `/downloads/${encodeURIComponent(path.basename(file))}`
      }))
    });
  } catch (error) {
    await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: 'Could not cut that video. Try another file format.' });
  }
});

// Desktop-only fast path: process the original local file instead of uploading it first.
app.post('/api/cut-local', upload.none(), async (req, res) => {
  const sourcePath = path.resolve(String(req.body.sourcePath || ''));
  const parts = Number.parseInt(req.body.parts, 10);
  const jobId = String(req.body.jobId || '');
  if (!sourcePath || !Number.isInteger(parts) || parts < 1 || parts > 20) {
    return res.status(400).json({ error: 'Choose a video and a valid number of parts.' });
  }
  try {
    await fsp.access(sourcePath, fs.constants.R_OK);
    const duration = await getDuration(sourcePath);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration unavailable');
    const sourceFolder = path.dirname(sourcePath);
    const outputNames = Array.from({ length: parts }, (_item, index) => `video${index + 1}.mp4`);
    const existing = await Promise.all(outputNames.map(async name => {
      try { await fsp.access(path.join(sourceFolder, name)); return name; } catch (_) { return null; }
    }));
    if (existing.some(Boolean)) {
      return res.status(409).json({ error: 'video1.mp4 already exists in this folder. Rename or move it, then try again.' });
    }
    // Write beside the original video directly — no upload and no second file copy.
    const pattern = path.join(sourceFolder, 'video%d.mp4');
    const partDuration = duration / parts;
    try {
      await render(ffmpeg(sourcePath).outputOptions(['-map 0:v:0', '-map 0:a?', '-c copy', '-f segment', `-segment_time ${partDuration}`, '-segment_start_number 1', '-reset_timestamps 1', '-avoid_negative_ts make_zero']).save(pattern), jobId);
    } catch (error) {
      if (error.cancelled) throw error;
      await Promise.all(outputNames.map(name => fsp.unlink(path.join(sourceFolder, name)).catch(() => {})));
      await render(ffmpeg(sourcePath).outputOptions(['-map 0:v:0', '-map 0:a?', '-c:v libx264', '-preset veryfast', '-crf 23', '-c:a aac', `-force_key_frames expr:gte(t,n_forced*${partDuration})`, '-f segment', `-segment_time ${partDuration}`, '-segment_start_number 1', '-reset_timestamps 1', '-movflags +faststart']).save(pattern), jobId);
    }
    const outputs = outputNames.map(name => path.join(sourceFolder, name));
    await Promise.all(outputs.map(file => fsp.access(file)));
    if (!outputs.length) throw new Error('No video parts were created');
    res.json({ localSaved: true, files: outputs.map((file, index) => ({ name: `cut-${index + 1}.mp4`, path: file })) });
  } catch (error) {
    res.status(500).json({ error: 'Could not cut that video. Try another file format.' });
  }
});

app.post('/api/combine-local', upload.none(), async (req, res) => {
  let sourcePaths = [];
  try { sourcePaths = JSON.parse(req.body.sourcePaths || '[]').map(value => path.resolve(String(value))); } catch (_) {}
  const jobId = String(req.body.jobId || '');
  const fadeDuration = Math.max(0, Math.min(10, Number(req.body.fadeDuration) || 0));
  if (sourcePaths.length < 2) return res.status(400).json({ error: 'Choose at least two videos to combine.' });
  const output = path.join(path.dirname(sourcePaths[0]), `combined-video-${Date.now()}.mp4`);
  const listFile = path.join(outputDir, `combine-${crypto.randomUUID()}.txt`);
  try {
    await Promise.all(sourcePaths.map(file => fsp.access(file, fs.constants.R_OK)));
    const concatLines = sourcePaths.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\\\''")}'`).join('\n');
    await fsp.writeFile(listFile, concatLines);
    if (fadeDuration > 0) await renderFadeCombine(sourcePaths, output, fadeDuration, jobId);
    else try {
      await render(ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy', '-movflags +faststart']).save(output), jobId);
    } catch (error) {
      if (error.cancelled) throw error;
      await fsp.unlink(output).catch(() => {});
      const command = ffmpeg();
      sourcePaths.forEach(file => command.input(file));
      const { width, height } = await getVideoSize(sourcePaths[0]);
      const inputs = sourcePaths.map((_file, index) => `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}];[${index}:a]aresample=async=1[a${index}]`).join(';');
      const joined = sourcePaths.map((_file, index) => `[v${index}][a${index}]`).join('') + `concat=n=${sourcePaths.length}:v=1:a=1[v][a]`;
      await render(command.complexFilter(`${inputs};${joined}`).outputOptions(['-map [v]', '-map [a]', '-c:v libx264', '-preset veryfast', '-crf 20', '-c:a aac', '-movflags +faststart']).save(output), jobId);
    }
    cleanLater([listFile]);
    res.json({ localSaved: true, files: [{ name: path.basename(output), path: output }] });
  } catch (_) {
    await fsp.unlink(listFile).catch(() => {});
    res.status(500).json({ error: 'Could not combine these videos. Try videos with the same format.' });
  }
});

app.post('/api/combine', upload.array('videos', 12), async (req, res) => {
  const files = req.files || [];
  if (files.length < 2) return res.status(400).json({ error: 'Choose at least two videos to combine.' });
  const output = path.join(outputDir, `combined-${crypto.randomUUID()}.mp4`);
  const listFile = path.join(outputDir, `combine-${crypto.randomUUID()}.txt`);
  const jobId = String(req.body.jobId || '');
  const fadeDuration = Math.max(0, Math.min(10, Number(req.body.fadeDuration) || 0));
  try {
    const concatLines = files.map(file => `file '${file.path.replace(/\\/g, '/').replace(/'/g, "'\\\\''")}'`).join('\n');
    await fsp.writeFile(listFile, concatLines);
    if (fadeDuration > 0) await renderFadeCombine(files.map(file => file.path), output, fadeDuration, jobId);
    else try {
      // Fast mode: joins matching codecs without encoding the video again.
      await render(ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy', '-movflags +faststart'])
        .save(output), jobId);
    } catch (error) {
      if (error.cancelled) throw error;
      await fsp.unlink(output).catch(() => {});
      const command = ffmpeg();
      files.forEach(file => command.input(file.path));
      const { width, height } = await getVideoSize(files[0].path);
      const inputs = files.map((_file, index) => `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}];[${index}:a]aresample=async=1[a${index}]`).join(';');
      const joined = files.map((_file, index) => `[v${index}][a${index}]`).join('') + `concat=n=${files.length}:v=1:a=1[v][a]`;
      await render(command
        .complexFilter(`${inputs};${joined}`)
        .outputOptions(['-map [v]', '-map [a]', '-c:v libx264', '-preset veryfast', '-crf 20', '-c:a aac', '-movflags +faststart'])
        .save(output), jobId);
    }
    cleanLater([...files.map(file => file.path), listFile, output]);
    res.download(output, 'combined-video.mp4');
  } catch (error) {
    await Promise.all([...files.map(file => fsp.unlink(file.path).catch(() => {})), fsp.unlink(listFile).catch(() => {})]);
    res.status(500).json({ error: 'Could not combine those videos. Make sure each has an audio track.' });
  }
});

app.listen(port, () => console.log(`Cut & Combine is ready at http://localhost:${port}`));
