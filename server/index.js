const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const os = require('os');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';

// Ensure public videos folder exists
const PUBLIC_VIDEOS = path.join(__dirname, 'public', 'videos');
fs.mkdirSync(PUBLIC_VIDEOS, { recursive: true });

function generateTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
  return dir;
}

async function fetchElevenAudio(text, voice = 'alloy', outPath) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVEN_API_KEY
    },
    body: JSON.stringify({ text })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ElevenLabs TTS failed: ${resp.status} ${txt}`);
  }

  // stream to file
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    resp.body.pipe(dest);
    resp.body.on('error', reject);
    dest.on('finish', () => resolve());
    dest.on('error', reject);
  });
}

function generateSilentMp3(durationSeconds, outPath) {
  return new Promise((resolve, reject) => {
    // ffmpeg must be installed on the machine
    // -f lavfi -i anullsrc creates silence
    const args = ['-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`, '-t', String(durationSeconds), '-q:a', '9', '-acodec', 'libmp3lame', outPath];
    const p = spawn('ffmpeg', args);
    p.on('error', (err) => reject(err));
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg silent generation failed with code ' + code));
    });
  });
}

function combineAudioAndVideo(inputVideoPath, audioPath, outPath) {
  return new Promise((resolve, reject) => {
    // replace audio with provided audio and copy video codec
    const args = ['-y', '-i', inputVideoPath, '-i', audioPath, '-c:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', outPath];
    const p = spawn('ffmpeg', args);
    p.on('error', (err) => reject(err));
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg combine failed with code ' + code));
    });
  });
}

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, voice = 'alloy', duration = 8 } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt_required' });

    // Use the sample video already in the repo
    const inputVideo = path.join(__dirname, '..', 'assets', 'videos', 'sample.mp4');
    if (!fs.existsSync(inputVideo)) {
      return res.status(500).json({ ok: false, error: 'sample_video_missing' });
    }

    const tmp = generateTempDir();
    const ttsPath = path.join(tmp, 'tts.mp3');
    const outName = `generated-${Date.now()}.mp4`;
    const outPath = path.join(PUBLIC_VIDEOS, outName);

    // Create TTS audio
    if (ELEVEN_API_KEY) {
      console.log('Using ElevenLabs TTS');
      await fetchElevenAudio(prompt, voice, ttsPath);
    } else {
      console.log('No ElevenLabs key, generating silent audio as placeholder');
      // Use duration from request (seconds)
      await generateSilentMp3(Number(duration) || 6, ttsPath);
    }

    // Combine
    await combineAudioAndVideo(inputVideo, ttsPath, outPath);

    // Serveable URL
    const publicUrl = `${req.protocol}://${req.get('host')}/videos/${outName}`;

    // Clean temp dir
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

    return res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Serve generated videos
app.use('/videos', express.static(path.join(__dirname, 'public', 'videos')));

app.listen(PORT, () => {
  console.log(`Generate server listening on ${PORT}`);
  console.log(`Videos will be served from /videos/*.mp4`);
});
