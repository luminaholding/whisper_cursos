// whisper.worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;
let isCancelled = false;
let resumeState = null;

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
          if (p.status === 'downloading')
            post({ type: 'model_progress', status: 'downloading', loaded: p.loaded, total: p.total });
          else if (p.status === 'loading')
            post({ type: 'model_progress', status: 'loading' });
        }
      }
    );
    post({ type: 'model_ready' });
  } catch (err) {
    post({ type: 'model_error', message: err.message });
  }
}

// ── Resample linear simples: converte qualquer SR para 16 kHz ──────
function resampleTo16k(pcm, fromSR) {
  if (fromSR === 16000) return pcm;
  const ratio = fromSR / 16000;
  const outLen = Math.round(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, pcm.length - 1);
    const frac = pos - lo;
    out[i] = pcm[lo] * (1 - frac) + pcm[hi] * frac;
  }
  return out;
}

// ── Transcrição em chunks ──────────────────────────────────────────
async function transcribe({ pcm, language, chunkSeconds, overlapSeconds, sampleRate, resumeFrom }) {
  if (!transcriber) {
    post({ type: 'error', message: 'Modelo não carregado' });
    return;
  }

  isCancelled = false;

  // PASSO 1: garantir que o PCM esteja em 16 kHz
  // O AudioContext do index.html JÁ decodifica a 16 kHz (sampleRate:16000),
  // mas caso o SR informado seja diferente, resamplamos aqui por segurança.
  const SR = 16000;
  const inputSR = sampleRate || 16000;
  const pcm16 = resampleTo16k(pcm, inputSR);

  // PASSO 2: calcular chunks sobre o PCM normalizado
  const CHUNK_SAMPLES   = chunkSeconds * SR;          // ex.: 300s * 16000 = 4.800.000
  const OVERLAP_SAMPLES = (overlapSeconds || 5) * SR; // ex.: 5s * 16000 = 80.000
  const STRIDE          = CHUNK_SAMPLES - OVERLAP_SAMPLES; // avanço real por chunk
  const totalSamples    = pcm16.length;

  // Quantos chunks cobrem TODO o áudio (sem contar o overlap inicial duplicado)
  const totalChunks = Math.ceil(totalSamples / STRIDE);

  // Log de diagnóstico — visível no console do worker
  post({
    type: 'debug',
    msg: `PCM: ${totalSamples} samples @ ${SR} Hz = ${(totalSamples/SR).toFixed(1)}s | ` +
         `${totalChunks} chunks de ${chunkSeconds}s (overlap ${overlapSeconds}s)`
  });

  // PASSO 3: estado inicial / retomada
  let startChunk      = 0;
  let fullText        = '';
  let chunkTexts      = new Array(totalChunks).fill('');
  let chunkStartTimes = new Array(totalChunks).fill(0);
  let chunkEndTimes   = new Array(totalChunks).fill(0);

  if (resumeFrom && resumeFrom.startChunk > 0) {
    startChunk      = resumeFrom.startChunk;
    fullText        = resumeFrom.fullText || '';
    chunkTexts      = resumeFrom.chunkTexts?.slice(0, totalChunks) || chunkTexts;
    chunkStartTimes = resumeFrom.chunkStartTimes || chunkStartTimes;
    chunkEndTimes   = resumeFrom.chunkEndTimes   || chunkEndTimes;
    post({ type: 'resume_started', fromChunk: startChunk, total: totalChunks });
  }

  resumeState = { language, chunkSeconds, overlapSeconds, sampleRate,
    startChunk, fullText, chunkTexts, chunkStartTimes, chunkEndTimes };

  // PASSO 4: loop de transcrição
  for (let i = startChunk; i < totalChunks; i++) {
    if (isCancelled) {
      resumeState = { language, chunkSeconds, overlapSeconds, sampleRate,
        startChunk: i, fullText, chunkTexts, chunkStartTimes, chunkEndTimes };
      post({ type: 'paused', fromChunk: i, total: totalChunks,
        fullText, chunkTexts, chunkStartTimes, chunkEndTimes });
      return;
    }

    // Início e fim em samples sobre o PCM normalizado
    const startSample = i * STRIDE;
    const endSample   = Math.min(startSample + CHUNK_SAMPLES, totalSamples);
    const chunk       = pcm16.slice(startSample, endSample);

    const startSec = startSample / SR;
    const endSec   = endSample   / SR;
    chunkStartTimes[i] = startSec;
    chunkEndTimes[i]   = endSec;

    const fmt = s => String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0');
    const timeLabel = `${fmt(startSec)} → ${fmt(endSec)}`;

    post({
      type: 'chunk_start', chunk: i+1, total: totalChunks,
      timeLabel, startSec, endSec,
      pct: Math.round((i / totalChunks) * 90)
    });

    try {
      const opts = { task: 'transcribe', return_timestamps: false };
      if (language) opts.language = language;

      const result = await transcriber(chunk, opts);
      const text = result.text.trim();

      chunkTexts[i] = text;
      fullText = chunkTexts.filter(Boolean).join(' ');

      resumeState = { language, chunkSeconds, overlapSeconds, sampleRate,
        startChunk: i+1, fullText, chunkTexts: [...chunkTexts],
        chunkStartTimes: [...chunkStartTimes], chunkEndTimes: [...chunkEndTimes] };

      post({
        type: 'chunk_done', chunk: i+1, total: totalChunks,
        timeLabel, startSec, endSec, text, fullText,
        pct: Math.round(((i+1) / totalChunks) * 90)
      });
    } catch (err) {
      post({ type: 'chunk_error', chunk: i+1, message: err.message });
    }
  }

  if (!isCancelled) {
    resumeState = null;
    post({ type: 'done', text: fullText });
  }
}

// ── Listener ───────────────────────────────────────────────────────
self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')            await loadModel(data.modelId);
  if (type === 'transcribe')      await transcribe(data);
  if (type === 'cancel')          isCancelled = true;
  if (type === 'get_resume_state') post({ type: 'resume_state', state: resumeState });
});
