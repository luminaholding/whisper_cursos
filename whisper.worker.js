// whisper.worker.js — roda em background, nao bloqueia a UI
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;

let transcriber = null;
let isCancelled = false;

// Persistencia de estado para retomada
// Guardamos no self (worker) o progresso parcial
let resumeState = null; // { pcm, language, chunkSeconds, overlapSeconds, sampleRate, startChunk, fullText, chunkTexts, chunkStartTimes, chunkEndTimes }

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

// ── Transcricao em chunks, com suporte a retomada ─────────────────
async function transcribe({ pcm, language, chunkSeconds, overlapSeconds, sampleRate, resumeFrom }) {
  if (!transcriber) {
    post({ type: 'error', message: 'Modelo nao carregado' });
    return;
  }

  isCancelled = false;
  const SR          = sampleRate || 16000;
  const CHUNK_SIZE  = chunkSeconds * SR;
  const OVERLAP     = (overlapSeconds || 5) * SR;
  const STRIDE      = CHUNK_SIZE - OVERLAP;
  const totalSamples = pcm.length;
  const totalChunks  = Math.ceil((totalSamples - OVERLAP) / STRIDE);

  // Se estamos retomando, restaura estado; senao comeca do zero
  let startChunk  = 0;
  let fullText    = '';
  let chunkTexts  = new Array(totalChunks).fill('');
  let chunkStartTimes = new Array(totalChunks).fill(0);
  let chunkEndTimes   = new Array(totalChunks).fill(0);

  if (resumeFrom && resumeFrom.startChunk > 0) {
    startChunk      = resumeFrom.startChunk;
    fullText        = resumeFrom.fullText || '';
    chunkTexts      = resumeFrom.chunkTexts || chunkTexts;
    chunkStartTimes = resumeFrom.chunkStartTimes || chunkStartTimes;
    chunkEndTimes   = resumeFrom.chunkEndTimes   || chunkEndTimes;
    post({ type: 'resume_started', fromChunk: startChunk, total: totalChunks });
  }

  // Salva referencia para permitir retomada posterior
  resumeState = { language, chunkSeconds, overlapSeconds, sampleRate, startChunk, fullText, chunkTexts, chunkStartTimes, chunkEndTimes };

  for (let i = startChunk; i < totalChunks; i++) {
    if (isCancelled) {
      // Ao cancelar, persiste o ponto exato onde parou
      resumeState = { language, chunkSeconds, overlapSeconds, sampleRate,
        startChunk: i, fullText, chunkTexts, chunkStartTimes, chunkEndTimes };
      post({ type: 'paused', fromChunk: i, total: totalChunks, fullText, chunkTexts, chunkStartTimes, chunkEndTimes });
      break;
    }

    const start = i * STRIDE;
    const end   = Math.min(start + CHUNK_SIZE, totalSamples);
    const chunk = pcm.slice(start, end);

    const startSec = start / SR;
    const endSec   = end   / SR;

    chunkStartTimes[i] = startSec;
    chunkEndTimes[i]   = endSec;

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
      const opts = { task: 'transcribe', return_timestamps: false };
      if (language) opts.language = language;

      const result = await transcriber(chunk, opts);
      const text = result.text.trim();

      chunkTexts[i] = text;
      fullText = chunkTexts.filter(Boolean).join(' ');

      // Atualiza estado de retomada apos cada chunk concluido
      resumeState = { language, chunkSeconds, overlapSeconds, sampleRate,
        startChunk: i + 1, fullText, chunkTexts: [...chunkTexts],
        chunkStartTimes: [...chunkStartTimes], chunkEndTimes: [...chunkEndTimes] };

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
  }

  if (!isCancelled) {
    resumeState = null; // Limpa ao concluir
    post({ type: 'done', text: fullText });
  }
}

// ── Listener ───────────────────────────────────────────────────────
self.addEventListener('message', async (e) => {
  const { type, ...data } = e.data;
  if (type === 'load')       await loadModel(data.modelId);
  if (type === 'transcribe') await transcribe(data);
  if (type === 'cancel')     isCancelled = true;
  // Retorna estado atual para retomada (UI pode pedir a qualquer momento)
  if (type === 'get_resume_state') post({ type: 'resume_state', state: resumeState });
});
