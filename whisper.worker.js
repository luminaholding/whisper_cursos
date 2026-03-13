// whisper.worker.js — roda em background, não bloqueia a UI
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;

// ── Helpers ────────────────────────────────────────────────────────
function post(data) { self.postMessage(data); }

// ── Carregar modelo ────────────────────────────────────────────────
async function loadModel(modelId) {
  post({ type: 'model_progress', status: 'start' });
  try {
    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelId,
      {
        progress_callback: (p) => {
          if (p.status === 'downloading') {
            post({ type: 'model_progress', status: 'downloading', loaded: p.loaded, total: p.total });
          } else if (p.status === 'loading') {
            post({ type: 'model_progress', status: 'loading' });
          }
        }
      }
    );
    post({ type: 'model_ready' });
  } catch (err) {
    post({ type: 'model_error', message: err.message });
  }
}

// ── Transcrição em chunks ──────────────────────────────────────────
async function transcribe({ pcm, language, chunkSeconds, sampleRate }) {
  if (!transcriber) {
    post({ type: 'error', message: 'Modelo não carregado' });
    return;
  }

  const CHUNK_SIZE = chunkSeconds * sampleRate;   // amostras por bloco
  const OVERLAP    = 5 * sampleRate;              // 5s de sobreposição entre blocos
  const STRIDE     = CHUNK_SIZE - OVERLAP;
  const totalChunks = Math.ceil((pcm.length - OVERLAP) / STRIDE);

  let fullText = '';

  for (let i = 0; i < totalChunks; i++) {
    const start = i * STRIDE;
    const end   = Math.min(start + CHUNK_SIZE, pcm.length);
    const chunk = pcm.slice(start, end);

    const minuteStart = Math.floor((start / sampleRate) / 60);
    const secStart    = Math.floor((start / sampleRate) % 60);
    const minuteEnd   = Math.floor((end   / sampleRate) / 60);
    const secEnd      = Math.floor((end   / sampleRate) % 60);
    const timeLabel   = `${String(minuteStart).padStart(2,'0')}:${String(secStart).padStart(2,'0')} → ${String(minuteEnd).padStart(2,'0')}:${String(secEnd).padStart(2,'0')}`;

    post({
      type: 'chunk_start',
      chunk: i + 1,
      total: totalChunks,
      timeLabel,
      pct: Math.round((i / totalChunks) * 90)
    });

    try {
      const result = await transcriber(chunk, {
        language,
        task: 'transcribe',
        return_timestamps: false
      });

      const text = result.text.trim();
      fullText += (fullText ? ' ' : '') + text;

      post({
        type: 'chunk_done',
        chunk: i + 1,
        total: totalChunks,
        timeLabel,
        text,
        fullText,
        pct: Math.round(((i + 1) / totalChunks) * 90)
      });
    } catch (err) {
      post({ type: 'chunk_error', chunk: i + 1, message: err.message });
      // continua para o próximo bloco mesmo com erro
    }
  }

  post({ type: 'done', text: fullText });
}

// ── Listener ───────────────────────────────────────────────────────
self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')        await loadModel(data.modelId);
  if (type === 'transcribe')  await transcribe(data);
});
