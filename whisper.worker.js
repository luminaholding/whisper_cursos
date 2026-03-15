// whisper.worker.js
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;
let isCancelled = false;
let resumeState = null;

function post(data) { self.postMessage(data); }

async function loadModel(modelId) {
  post({ type: 'model_progress', status: 'start' });
  isCancelled = false;
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

// Resample linear: SR real do dispositivo (44100/48000) -> 16 kHz
// O AudioContext no Android ignora sampleRate:16000 e usa o SR nativo do hardware.
// Por isso recebemos o SR real e fazemos o resample ANTES de qualquer calculo de chunk.
function resampleTo16k(pcm, fromSR) {
  if (fromSR === 16000) return pcm;
  const ratio = fromSR / 16000;
  const outLen = Math.round(pcm.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    out[i] = pcm[lo] * (1 - (pos - lo)) + pcm[hi] * (pos - lo);
  }
  return out;
}

async function transcribe({ pcm, language, chunkSeconds, overlapSeconds, sampleRate, resumeFrom }) {
  if (!transcriber) { post({ type: 'error', message: 'Modelo não carregado' }); return; }

  isCancelled = false;
  const SR = 16000;
  const inputSR = sampleRate || 16000;

  // Passo 1: resampla para 16 kHz usando o SR REAL
  const pcm16 = resampleTo16k(pcm, inputSR);

  // Passo 2: calcula chunks sobre PCM ja em 16 kHz
  const CHUNK_SAMPLES   = chunkSeconds * SR;
  const OVERLAP_SAMPLES = Math.round((overlapSeconds || 5) * SR);
  const STRIDE          = CHUNK_SAMPLES - OVERLAP_SAMPLES;
  const totalSamples    = pcm16.length;
  const totalChunks     = Math.ceil(totalSamples / STRIDE);

  post({ type: 'debug', msg: `SR real: ${inputSR}Hz | apos resample: ${totalSamples} amostras = ${(totalSamples/SR).toFixed(1)}s | ${totalChunks} chunks de ${chunkSeconds}s` });

  // Passo 3: estado inicial / retomada
  let startChunk      = 0;
  let fullText        = '';
  let chunkTexts      = new Array(totalChunks).fill('');
  let chunkStartTimes = new Array(totalChunks).fill(0);
  let chunkEndTimes   = new Array(totalChunks).fill(0);

  if (resumeFrom && resumeFrom.startChunk > 0) {
    startChunk      = resumeFrom.startChunk;
    fullText        = resumeFrom.fullText || '';
    const prev      = resumeFrom.chunkTexts || [];
    chunkTexts      = prev.concat(new Array(Math.max(0, totalChunks - prev.length)).fill('')).slice(0, totalChunks);
    chunkStartTimes = resumeFrom.chunkStartTimes || chunkStartTimes;
    chunkEndTimes   = resumeFrom.chunkEndTimes   || chunkEndTimes;
    post({ type: 'resume_started', fromChunk: startChunk, total: totalChunks });
  }

  // Passo 4: loop
  for (let i = startChunk; i < totalChunks; i++) {
    if (isCancelled) {
      post({ type: 'paused', fromChunk: i, total: totalChunks, fullText, chunkTexts, chunkStartTimes, chunkEndTimes });
      return;
    }

    const startSample = i * STRIDE;
    const endSample   = Math.min(startSample + CHUNK_SAMPLES, totalSamples);
    const chunk       = pcm16.slice(startSample, endSample);
    const startSec    = startSample / SR;
    const endSec      = endSample   / SR;
    chunkStartTimes[i] = startSec;
    chunkEndTimes[i]   = endSec;

    const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    const timeLabel = `${fmt(startSec)} → ${fmt(endSec)}`;

    post({ type: 'chunk_start', chunk: i + 1, total: totalChunks, timeLabel, startSec, endSec, pct: Math.round((i / totalChunks) * 90) });

    try {
      const opts = { task: 'transcribe', return_timestamps: false };
      if (language) opts.language = language;
      const result = await transcriber(chunk, opts);
      const text = result.text.trim();
      chunkTexts[i] = text;
      fullText = chunkTexts.filter(Boolean).join(' ');
      post({ type: 'chunk_done', chunk: i + 1, total: totalChunks, timeLabel, startSec, endSec, text, fullText, pct: Math.round(((i + 1) / totalChunks) * 90) });
    } catch (err) {
      post({ type: 'chunk_error', chunk: i + 1, message: err.message });
    }
  }

  if (!isCancelled) {
    resumeState = null;
    post({ type: 'done', text: fullText });
  }
}

self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')       await loadModel(data.modelId);
  if (type === 'transcribe') await transcribe(data);
  if (type === 'cancel')     isCancelled = true;
});
