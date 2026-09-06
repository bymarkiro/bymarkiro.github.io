const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY || '';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || '';

// Ensure public videos folder exists
const PUBLIC_VIDEOS = path.join(__dirname, 'public', 'videos');
fs.mkdirSync(PUBLIC_VIDEOS, { recursive: true });

/**
 * Generate video using Replicate API (Runway or similar)
 * Supports text-to-video generation
 */
async function generateVideoWithReplicate(prompt, duration = 10) {
  if (!REPLICATE_API_KEY) {
    throw new Error('REPLICATE_API_KEY not configured');
  }

  // Create prediction on Replicate
  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${REPLICATE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      version: 'e04e9dce6330d59db81880486bafab8438c2e5b9d0fa2e9b57841e391287ff17', // Runway Gen3 Turbo
      input: {
        prompt: prompt,
        num_frames: duration * 24, // 24fps
        loop: false
      }
    })
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Replicate creation failed: ${createRes.status} ${err}`);
  }

  const prediction = await createRes.json();
  let predId = prediction.id;

  // Poll until done (max 5 minutes)
  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` }
    });

    if (!statusRes.ok) {
      throw new Error(`Status check failed: ${statusRes.status}`);
    }

    const status = await statusRes.json();

    if (status.status === 'succeeded') {
      if (status.output && status.output.length > 0) {
        return status.output[0]; // Return video URL
      }
      throw new Error('Replicate succeeded but no output URL');
    }

    if (status.status === 'failed') {
      throw new Error(`Video generation failed: ${status.error}`);
    }

    // Wait before polling again
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
  }

  throw new Error('Video generation timeout');
}

/**
 * Download video from URL and save locally
 */
async function downloadVideo(videoUrl) {
  const outName = `generated-${Date.now()}.mp4`;
  const outPath = path.join(PUBLIC_VIDEOS, outName);

  const resp = await fetch(videoUrl);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status}`);
  }

  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    resp.body.pipe(dest);
    resp.body.on('error', reject);
    dest.on('finish', () => resolve(outName));
    dest.on('error', reject);
  });
}

/**
 * POST /api/generate
 * Request: { prompt, duration }
 * Response: { ok: true, url: "..." } or { ok: false, error: "..." }
 */
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, duration = 10 } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt_required' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'REPLICATE_API_KEY not configured. Set it in .env file.'
      });
    }

    console.log(`[Generate] Prompt: "${prompt.slice(0, 50)}..." Duration: ${duration}s`);

    // Generate video on Replicate
    const videoUrl = await generateVideoWithReplicate(prompt, Math.min(duration, 10));

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
 * Request: { prompt }
 * Response: { ok: true, url: "..." } or { ok: false, error: "..." }
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
        version: '8926d02a3a8bbc86e7b8f5db3b5c0d6c4a3e7f8a9b0c1d2e3f4a5b6c7d8e9f0', // FLUX pro
        input: {
          prompt: prompt,
          aspect_ratio: '16:9',
          num_outputs: 1
        }
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Image generation failed: ${createRes.status} ${err}`);
    }

    const prediction = await createRes.json();
    let predId = prediction.id;

    // Poll for result
    let attempts = 0;
    while (attempts < 30) {
      const statusRes = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
        headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` }
      });

      const status = await statusRes.json();

      if (status.status === 'succeeded' && status.output && status.output.length > 0) {
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
 * Convert uploaded photo to video
 */
app.post('/api/photo-to-video', async (req, res) => {
  try {
    const { allow_nsfw } = req.body || {};

    if (!req.files || !req.files.photo) {
      return res.status(400).json({ ok: false, error: 'photo_required' });
    }

    if (!REPLICATE_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    console.log('[PhotoVideo] Converting uploaded photo...');

    // For now, return a simple response
    // In production, you'd upload the photo and use image-to-video model
    return res.json({
      ok: true,
      url: `/videos/sample-${Date.now()}.mp4`,
      message: 'Photo-to-video feature coming soon'
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
  res.json({ ok: true, api_configured: !!REPLICATE_API_KEY });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📹 Videos served from /videos`);
  console.log(`✅ REPLICATE_API_KEY: ${REPLICATE_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`📱 CORS enabled`);
});
