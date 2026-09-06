const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// Multer para subidas de archivos
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || '';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';

// Ensure public videos folder exists
const PUBLIC_VIDEOS = path.join(__dirname, 'public', 'videos');
fs.mkdirSync(PUBLIC_VIDEOS, { recursive: true });

/**
 * Generate video using Replicate API
 * Supports text-to-video generation with optional image input
 */
async function generateVideoWithReplicate(prompt, duration = 10, imageBase64 = null) {
  if (!REPLICATE_API_KEY) {
    throw new Error('REPLICATE_API_KEY not configured');
  }

  const input = {
    prompt: prompt,
    num_inference_steps: 40,
    guidance_scale: 7.5
  };

  // Si hay imagen, usarla como frame inicial
  if (imageBase64) {
    input.image = `data:image/jpeg;base64,${imageBase64}`;
  }

  // Create prediction on Replicate
  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: '4d0d4c0f2891efb58f1201b374dd2150273c25579e65b428c14ca1ee84c09341', // Runway Gen3 Turbo
      input: input
    })
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Replicate creation failed: ${createRes.status} ${err}`);
  }

  const prediction = await createRes.json();
  let predId = prediction.id;

  console.log(`[Replicate] Prediction ID: ${predId}`);

  // Poll until done (max 10 minutes)
  let attempts = 0;
  const maxAttempts = 120;

  while (attempts < maxAttempts) {
    const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` }
    });

    if (!statusRes.ok) {
      throw new Error(`Status check failed: ${statusRes.status}`);
    }

    const status = await statusRes.json();
    console.log(`[Replicate] Status: ${status.status}`);

    if (status.status === 'succeeded') {
      if (status.output && status.output.length > 0) {
        return status.output[0]; // Return video URL
      }
      throw new Error('Replicate succeeded but no output URL');
    }

    if (status.status === 'failed') {
      throw new Error(`Video generation failed: ${status.error || 'Unknown error'}`);
    }

    // Wait before polling again (5 seconds)
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
  }

  throw new Error('Video generation timeout (10+ minutes)');
}

/**
 * Download video from URL and save locally
 */
async function downloadVideo(videoUrl) {
  const outName = `generated-${Date.now()}.mp4`;
  const outPath = path.join(PUBLIC_VIDEOS, outName);

  console.log(`[Download] Downloading from: ${videoUrl.substring(0, 50)}...`);

  const resp = await fetch(videoUrl);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status}`);
  }

  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    resp.body.pipe(dest);
    resp.body.on('error', reject);
    dest.on('finish', () => {
      console.log(`[Download] Saved to: ${outName}`);
      resolve(outName);
    });
    dest.on('error', reject);
  });
}

/**
 * POST /api/generate
 * Generate video from text prompt (with optional image)
 * Request: { prompt, duration, image_base64 (optional) }
 */
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, duration = 10, image_base64 = null } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt_required' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'REPLICATE_API_KEY not configured. Set it in .env file.'
      });
    }

    console.log(`[Generate] Prompt: "${prompt.slice(0, 50)}..." Duration: ${duration}s Image: ${image_base64 ? 'Yes' : 'No'}`);

    // Generate video on Replicate
    const videoUrl = await generateVideoWithReplicate(
      prompt, 
      Math.min(duration, 10),
      image_base64
    );

    // Download to local storage
    const fileName = await downloadVideo(videoUrl);

    // Return serveable URL
    const publicUrl = `${req.protocol}://${req.get('host')}/videos/${fileName}`;

    return res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error('[Generate Error]', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Generation failed'
    });
  }
});

/**
 * POST /api/generate-image
 * Generate image from text prompt using FLUX
 */
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt_required' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'REPLICATE_API_KEY not configured'
      });
    }

    console.log(`[Image] Prompt: "${prompt.slice(0, 50)}..."`);

    // Use FLUX for image generation
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: 'e04e9dce6330d59db81880486bafab8438c2e5b9d0fa2e9b57841e391287ff17', // FLUX
        input: {
          prompt: prompt,
          guidance: 3,
          num_outputs: 1,
          aspect_ratio: '16:9'
        }
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Image generation failed: ${createRes.status} ${err}`);
    }

    const prediction = await createRes.json();
    let predId = prediction.id;

    console.log(`[Image] Prediction ID: ${predId}`);

    // Poll for result
    let attempts = 0;
    while (attempts < 60) {
      const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
        headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` }
      });

      const status = await statusRes.json();

      if (status.status === 'succeeded' && status.output && status.output.length > 0) {
        console.log(`[Image] Generated successfully`);
        return res.json({ ok: true, url: status.output[0] });
      }

      if (status.status === 'failed') {
        throw new Error(`Image generation failed: ${status.error}`);
      }

      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }

    throw new Error('Image generation timeout');
  } catch (err) {
    console.error('[Image Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/photo-to-video
 * Convert uploaded photo to video with motion and animation
 * Uses the photo as key frame and generates motion
 */
app.post('/api/photo-to-video', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'photo_required' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    const { allow_nsfw = false, prompt = 'Smooth camera motion and subtle animation' } = req.body;

    console.log(`[PhotoVideo] Converting uploaded photo... Size: ${req.file.size} bytes`);

    // Convert image buffer to base64
    const imageBase64 = req.file.buffer.toString('base64');

    // Generate video using the uploaded photo
    const videoUrl = await generateVideoWithReplicate(
      `Photo animation: ${prompt}. Use the provided image as the key frame.`,
      10,
      imageBase64
    );

    // Download to local storage
    const fileName = await downloadVideo(videoUrl);

    // Return serveable URL
    const publicUrl = `${req.protocol}://${req.get('host')}/videos/${fileName}`;

    return res.json({
      ok: true,
      url: publicUrl,
      message: 'Photo converted to video successfully'
    });
  } catch (err) {
    console.error('[PhotoVideo Error]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve static videos
app.use('/videos', express.static(path.join(__dirname, 'public', 'videos')));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    api_configured: !!REPLICATE_API_KEY,
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 MotionFlow AI Server running on http://localhost:${PORT}`);
  console.log(`📹 Videos served from /videos`);
  console.log(`✅ REPLICATE_API_KEY: ${REPLICATE_API_KEY ? '✓ configured' : '✗ MISSING'}`);
  console.log(`📱 CORS enabled`);
  console.log(`${('=').repeat(60)}\n`);
});
