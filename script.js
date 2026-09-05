async function requestGenerateWithVoice(promptText, voice = 'alloy', duration = 8) {
  try {
    showToast('Generando audio y mezclando...');

    const endpoint = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:3000/api/generate'
      : '/api/generate';

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, voice, duration })
    });

    const data = await resp.json();
    if (!data.ok) {
      showToast('Error al generar: ' + (data.error || 'unknown'), true);
      return;
    }

    // Usa la URL devuelta
    lastGeneratedVideoUrl = data.url;
    lastGeneratedVideoName = lastGeneratedVideoUrl.split('/').pop();

    const preview = document.getElementById('studioPreview');
    if (preview) {
      preview.innerHTML = `<video id="generatedVideo" controls src="${lastGeneratedVideoUrl}" style="max-width:100%;border-radius:8px"></video>`;
    }
    const downloadBtn = document.getElementById('downloadBtn');
    if (downloadBtn) downloadBtn.disabled = false;
    showToast('Generación completada. Puedes reproducir o descargar.');
  } catch (err) {
    console.error(err);
    showToast('Error durante la generación', true);
  }
}

// Override generate button to call server-side generation with voice
const originalGenerate = generateVideo;
const genBtn = document.getElementById('generateBtn');
if (genBtn) {
  genBtn.removeEventListener('click', generateVideo);
  genBtn.addEventListener('click', async () => {
    const promptInput = document.getElementById('videoPrompt');
    const durationInput = document.getElementById('videoDuration');
    const prompt = promptInput ? promptInput.value.trim() : '';
    const duration = durationInput ? Number(durationInput.value) : 8;

    // If user uploaded a photo and chose photo-video, keep existing flow
    const photoInputEl = document.getElementById('photoInput');
    const file = photoInputEl && photoInputEl.files ? photoInputEl.files[0] : null;
    if (file) {
      // fallback to current quick-create handler path
      originalGenerate();
      return;
    }

    if (!prompt) {
      showToast('Escribe una descripción/prompt antes de generar.', true);
      return;
    }

    await requestGenerateWithVoice(prompt, 'alloy', duration);
  });
}
