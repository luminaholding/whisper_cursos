// whisper.worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;
let isCancelled = false;

function post(data) { self.postMessage(data); }

// ─── Carregamento do modelo ───────────────────────────────────────────────────
async function loadModel(modelId) {
  isCancelled = false;
  post({ type: 'model_progress', status: 'start' });
  try {
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      progress_callback: (p) => {
        if (p.status === 'downloading')
          post({ type: 'model_progress', status: 'downloading', loaded: p.loaded, total: p.total });
        else if (p.status === 'loading')
          post({ type: 'model_progress', status: 'loading' });
      }
    });
    post({ type: 'model_ready' });
  } catch (err) {
    post({ type: 'model_error', message: err.message });
  }
}

// ─── Resample linear para 16 kHz ─────────────────────────────────────────────
// O AudioContext no Android usa o SR nativo do hardware (44100/48000).
// Recebemos o SR real e fazemos resample ANTES de calcular chunks.
function resampleTo16k(pcm, fromSR) {
  if (fromSR === 16000) return pcm;
  const ratio  = fromSR / 16000;
  const outLen = Math.round(pcm.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, pcm.length - 1);
    out[i]    = pcm[lo] * (1 - (pos - lo)) + pcm[hi] * (pos - lo);
  }
  return out;
}

// ─── Transcrição em chunks ────────────────────────────────────────────────────
async function transcribe({ pcm, language, chunkSeconds, overlapSeconds, sampleRate, resumeFrom }) {
  if (!transcriber) { post({ type: 'error', message: 'Modelo não carregado' }); return; }

  isCancelled = false;
  const SR             = 16000;
  const inputSR        = sampleRate || 16000;
  const pcm16          = resampleTo16k(pcm, inputSR);

  const CHUNK_SAMPLES  = (chunkSeconds  || 30) * SR;
  const OVERLAP_SAMPLES = (overlapSeconds || 5) * SR;
  const STRIDE         = CHUNK_SAMPLES - OVERLAP_SAMPLES;
  const totalSamples   = pcm16.length;
  const totalChunks    = Math.ceil(totalSamples / STRIDE);

  // estado inicial ou retomada
  let startChunk      = 0;
  let fullText        = '';
  let chunkTexts      = new Array(totalChunks).fill('');
  let chunkStartTimes = new Array(totalChunks).fill(0);
  let chunkEndTimes   = new Array(totalChunks).fill(0);

  if (resumeFrom?.startChunk > 0) {
    startChunk      = resumeFrom.startChunk;
    fullText        = resumeFrom.fullText || '';
    const prev      = resumeFrom.chunkTexts || [];
    chunkTexts      = [...prev, ...new Array(Math.max(0, totalChunks - prev.length)).fill('')].slice(0, totalChunks);
    chunkStartTimes = resumeFrom.chunkStartTimes || chunkStartTimes;
    chunkEndTimes   = resumeFrom.chunkEndTimes   || chunkEndTimes;
    post({ type: 'resume_started', fromChunk: startChunk, total: totalChunks });
  }

  const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  for (let i = startChunk; i < totalChunks; i++) {
    if (isCancelled) {
      post({ type: 'paused', fromChunk: i, total: totalChunks, fullText, chunkTexts, chunkStartTimes, chunkEndTimes });
      return;
    }

    const startSample  = i * STRIDE;
    const endSample    = Math.min(startSample + CHUNK_SAMPLES, totalSamples);
    const chunk        = pcm16.slice(startSample, endSample);
    const startSec     = startSample / SR;
    const endSec       = endSample   / SR;
    chunkStartTimes[i] = startSec;
    chunkEndTimes[i]   = endSec;

    const timeLabel = `${fmt(startSec)} → ${fmt(endSec)}`;
    const pctStart  = Math.round((i       / totalChunks) * 90);
    const pctEnd    = Math.round(((i + 1) / totalChunks) * 90);

    post({ type: 'chunk_start', chunk: i + 1, total: totalChunks, timeLabel, startSec, endSec, pct: pctStart });

    try {
      const opts = { task: 'transcribe', return_timestamps: false };
      if (language) opts.language = language;
      const result = await transcriber(chunk, opts);
      const text   = result.text.trim();
      chunkTexts[i] = text;
      fullText = chunkTexts.filter(Boolean).join(' ');
      post({ type: 'chunk_done', chunk: i + 1, total: totalChunks, timeLabel, startSec, endSec, text, fullText, pct: pctEnd });
    } catch (err) {
      post({ type: 'chunk_error', chunk: i + 1, message: err.message });
    }
  }

  if (!isCancelled) {
    post({ type: 'done', text: fullText });
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')       await loadModel(data.modelId);
  if (type === 'transcribe') await transcribe(data);
  if (type === 'cancel')     isCancelled = true;
});
