// whisper.worker.js — roda em background, não bloqueia a UI
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;
let isCancelled = false;

function post(data) { self.postMessage(data); }

// ── Carregar modelo ────────────────────────────────────────────────
async function loadModel(modelId) {
  post({ type: 'model_progress', status: 'start' });
  isCancelled = false;
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

// ── Transcrição em chunks, libera referências antigas ──────────────
async function transcribe({ pcm, language, chunkSeconds, overlapSeconds, sampleRate }) {
  if (!transcriber) {
    post({ type: 'error', message: 'Modelo não carregado' });
    return;
  }

  isCancelled = false;
  const SR          = sampleRate || 16000;
  const CHUNK_SIZE  = chunkSeconds * SR;
  const OVERLAP     = (overlapSeconds || 5) * SR;
  const STRIDE      = CHUNK_SIZE - OVERLAP;
  const totalSamples = pcm.length;
  const totalChunks  = Math.ceil((totalSamples - OVERLAP) / STRIDE);

  let fullText = '';

  for (let i = 0; i < totalChunks; i++) {
    if (isCancelled) break;

    const start = i * STRIDE;
    const end   = Math.min(start + CHUNK_SIZE, totalSamples);

    // Cópia isolada do bloco — permite que o GC colete partes já processadas
    const chunk = pcm.slice(start, end);

    const startSec = start / SR;
    const endSec   = end   / SR;

    function fmt(sec) {
      const m = String(Math.floor(sec / 60)).padStart(2,'0');
      const s = String(Math.floor(sec % 60)).padStart(2,'0');
      return `${m}:${s}`;
    }
    const timeLabel = `${fmt(startSec)} → ${fmt(endSec)}`;

    post({
      type: 'chunk_start',
      chunk: i + 1,
      total: totalChunks,
      timeLabel,
      startSec,
      endSec,
      pct: Math.round((i / totalChunks) * 90)
    });

    try {
      const opts = {
        task: 'transcribe',
        return_timestamps: false
      };
      if (language) opts.language = language;

      const result = await transcriber(chunk, opts);
      const text = result.text.trim();
      fullText += (fullText ? ' ' : '') + text;

      post({
        type: 'chunk_done',
        chunk: i + 1,
        total: totalChunks,
        timeLabel,
        startSec,
        endSec,
        text,
        fullText,
        pct: Math.round(((i + 1) / totalChunks) * 90)
      });
    } catch (err) {
      post({ type: 'chunk_error', chunk: i + 1, message: err.message });
    }

    // Dica ao GC: solta referência do chunk processado
    // (o pcm original ainda existe mas o slice já foi usado)
  }

  if (!isCancelled) {
    post({ type: 'done', text: fullText });
  }
}

// ── Listener ───────────────────────────────────────────────────────
self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')       await loadModel(data.modelId);
  if (type === 'transcribe') await transcribe(data);
  if (type === 'cancel')     isCancelled = true;
});
