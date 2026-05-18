/**
 * Minimal Gemini Live browser demo targeting `gemini-3.1-flash-live-preview`.
 */
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  VoiceActivityType,
  VadSignalType,
} from '@google/genai';

const MODEL = 'gemini-3.1-flash-live-preview';

const $ = (id) => document.getElementById(id);

const wantAudioEl = $('wantAudio');
const listenHintEl = $('listenHint');
const btnConnect = $('btnConnect');
const btnDisconnect = $('btnDisconnect');
const statusEl = $('status');
const logEl = $('log');

/** @type {import('@google/genai').Session | null} */
let session = null;
/** @type {null | (() => Promise<void>)} */
let micDispose = null;
const pcmOut = createPcmPlayback();

function getApiKey() {
  const w = /** @type {{ __GEMINI_API_KEY__?: string }} */ (window);
  return typeof w.__GEMINI_API_KEY__ === 'string' ? w.__GEMINI_API_KEY__.trim() : '';
}

function setListeningUi(active) {
  if (!listenHintEl) return;
  listenHintEl.textContent =
    active
      ? 'Listening — pause briefly and Gemini will respond.'
      : '';
  listenHintEl.classList.toggle('is-live', active);
}

/** @typedef {{ ctx: AudioContext, processor: ScriptProcessorNode, mic: MediaStreamAudioSourceNode, stream: MediaStream, sink: GainNode }} MicChain */

/**
 * @param {(chunk: Int16Array) => void} onPcmChunk
 * @returns {Promise<MicChain>}
 */
function startMicPump(onPcmChunk) {
  return navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })
    .then((stream) => {
      const ctx = new AudioContext();
      const mic = ctx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = (e) => {
        const mono = e.inputBuffer.getChannelData(0);
        const resampled = resampleLinear(mono, ctx.sampleRate, 16000);
        const chunk = floatToInt16LE(resampled);
        onPcmChunk(chunk);
      };
      mic.connect(processor);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(ctx.destination);
      return { ctx, processor, mic, stream, sink };
    });
}

/** @param {MicChain|null} chain */
async function teardownMic(chain) {
  if (!chain) return;
  try {
    chain.processor.disconnect();
    chain.mic.disconnect();
    chain.sink.disconnect();
    await chain.ctx.close();
  } catch {
    /* noop */
  }
  chain.stream.getTracks().forEach((t) => t.stop());
}

function resampleLinear(input, inputRate, outRate) {
  if (inputRate === outRate || input.length === 0) {
    return new Float32Array(input);
  }
  const outLen = Math.max(1, Math.round((input.length * outRate) / inputRate));
  const out = new Float32Array(outLen);
  const ratio = (input.length - 1) / Math.max(outLen - 1, 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** @param {Float32Array} floats */
function floatToInt16LE(floats) {
  const buf = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    buf[i] =
      s < 0 ? (s >= -1 ? Math.floor(s * 0x8000) : -0x8000) : Math.floor(s * 0x7fff);
  }
  return buf;
}

/** @param {Uint8Array | Int16Array} bytes */
function toBase64Binary(bytes) {
  const u8 =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

function createPcmPlayback() {
  let ctx = null;
  /** @type {number} */
  let nextTime = 0;
  /** @type {Set<AudioBufferSourceNode>} */
  const activeSources = new Set();

  /** @param {AudioBufferSourceNode} src */
  function rememberSource(src) {
    activeSources.add(src);
    src.onended = () => activeSources.delete(src);
  }

  function stopAll() {
    for (const src of activeSources) {
      try {
        src.stop(0);
      } catch {
        /* already stopped or never started */
      }
    }
    activeSources.clear();
    if (ctx) {
      nextTime = ctx.currentTime;
    }
  }

  async function resume() {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 24000 });
    }
    await ctx.resume();
    nextTime = Math.max(nextTime, ctx.currentTime);
  }

  /** @param {Int16Array} samples */
  function push(samples) {
    if (!samples.length) return;
    if (!ctx) return;
    const buf = ctx.createBuffer(1, samples.length, 24000);
    const data = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      data[i] = Math.max(-1, Math.min(1, samples[i] / 32768));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    rememberSource(src);
    const startAt = Math.max(ctx.currentTime, nextTime);
    src.connect(ctx.destination);
    src.start(startAt);
    nextTime = startAt + buf.duration;
  }

  async function teardown() {
    stopAll();
    if (ctx && ctx.state !== 'closed') {
      await ctx.close();
    }
    ctx = null;
  }

  return { resume, push, stopAll, teardown };
}

function decodePcmPartsFromTurn(modelTurn) {
  const blobs = [];
  if (!modelTurn?.parts?.length) return blobs;
  for (const part of modelTurn.parts) {
    const blob = part.inlineData;
    if (!blob?.data) continue;
    const mt = blob.mimeType || '';
    const isAudioPcm =
      mt.includes('audio/pcm') || mt.includes('audio/L16') || mt.endsWith('+pcm');
    if (!isAudioPcm && !mt.includes('pcm')) continue;
    const raw = atob(blob.data);
    const buf = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(buf);
    blobs.push(int16);
  }
  return blobs;
}

/** Whether the backend says the user's speech begins (stop model playback ASAP). */
function isUserSpeechStartSignal(message, sc) {
  if (!sc?.interrupted) {
    if (message.voiceActivityDetectionSignal?.vadSignalType === VadSignalType.VAD_SIGNAL_TYPE_SOS) return true;
    if (message.voiceActivity?.voiceActivityType === VoiceActivityType.ACTIVITY_START)
      return true;
  }
  return false;
}

/** @param {import('@google/genai').LiveServerMessage} message */
async function dispatchServerMessage(message) {
  const sc = message.serverContent;

  if (message.setupComplete) {
    appendLog(
      'session',
      'Setup complete — microphone audio streams continuously. Pause briefly between thoughts so Gemini can jump in.',
      true
    );
    return;
  }

  if (sc?.interrupted === true || isUserSpeechStartSignal(message, sc)) {
    pcmOut.stopAll();
  }

  if (sc?.inputTranscription?.text?.trim()) {
    appendLog('youΔ', `(input transcript) ${sc.inputTranscription.text}`);
  }

  if (sc?.outputTranscription?.text?.trim()) {
    appendLog('modelΔ', `(output transcript) ${sc.outputTranscription.text}`);
  }

  if (sc?.modelTurn?.parts?.length) {
    const textPieces = [];
    for (const p of sc.modelTurn.parts) {
      if (p.text?.trim()) textPieces.push(p.text);
    }
    if (textPieces.length) appendLog('model', textPieces.join(''));
    const pcmPieces =
      sc?.interrupted === true ? [] : decodePcmPartsFromTurn(sc.modelTurn);
    for (const chunk of pcmPieces) {
      if (!wantAudioEl.checked) continue;
      await pcmOut.resume();
      pcmOut.push(chunk);
    }
  } else if (typeof message.text === 'string' && message.text.trim()) {
    appendLog('model', message.text);
  }

  if (sc?.interrupted) {
    appendLog('system', '[Interrupted — playback chopped]', true);
  }

  if (sc?.generationComplete || sc?.turnComplete) {
    appendLog('', '', false, true);
  }
}

function appendLog(role, msg, muted = false, blankSeparator = false) {
  if (blankSeparator) {
    logEl.appendChild(document.createElement('br'));
    return;
  }
  const line = document.createElement('div');
  line.className = `line ${role}`;
  if (muted) line.classList.add('muted');

  const t = new Date().toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  line.appendChild(document.createTextNode(`[${t}] `));
  if (role === 'session') line.append(msg);
  else if (role === 'youΔ' || role === 'modelΔ') line.append(msg);
  else if (role === 'model')
    line.appendChild(document.createTextNode(`model: ${msg}`));
  else if (role === 'system')
    line.appendChild(document.createTextNode(`system: ${msg}`));
  else line.append(msg);

  logEl.appendChild(line);

  requestAnimationFrame(() => logEl.scrollTo({ top: logEl.scrollHeight }));
}

async function disconnect() {
  setListeningUi(false);
  btnDisconnect.disabled = true;
  if (micDispose) {
    await micDispose().catch(() => {});
    micDispose = null;
  }
  try {
    if (session) {
      session.sendRealtimeInput({ audioStreamEnd: true });
    }
  } catch {
    /* noop */
  }
  if (session) {
    try {
      session.close();
    } catch {
      /* noop */
    }
    session = null;
  }
  await pcmOut.teardown();
  setStatus(false);
}

function setStatus(ok) {
  statusEl.textContent = ok ? 'Connected' : 'Disconnected';
  statusEl.classList.toggle('connected', ok);
  statusEl.classList.toggle('disconnected', !ok);
  btnConnect.disabled = ok;
  btnDisconnect.disabled = !ok;
  if (!ok) setListeningUi(false);
}

async function connect() {
  logEl.replaceChildren(restoreLogHint());
  const key = getApiKey();
  if (!key) {
    appendLog(
      'system',
      'GEMINI_API_KEY is not configured on the server.'
    );
    return;
  }
  if (key.length < 20) {
    appendLog('system', 'API key looks too short.');
    return;
  }
  if (!key.startsWith('AIza')) {
    appendLog('system', 'Expected a Gemini key starting with AIza…');
    return;
  }

  await disconnect();

  // `gemini-3.1-flash-live-preview` is a *native audio* Live model: the API
  // rejects TEXT response modality with WebSocket close 1011 ("Internal error").
  // Use AUDIO only and read text from `outputAudioTranscription` (+ optional PCM decode).
  // See: https://ai.google.dev/gemini-api/docs/live-api/capabilities#response-modalities
  const modalities = [Modality.AUDIO];

  const ai = new GoogleGenAI({ apiKey: key });

  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: modalities,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Puck' },
          },
        },
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => appendLog('session', 'WebSocket opened.', true),
        onmessage: dispatchServerMessage,
        onerror: (e) => {
          const err = /** @type {ErrorEvent & { error?: unknown }} */ (e);
          const detail =
            err.error instanceof Error
              ? err.error.message
              : String(err.message || err.error || 'Unknown error');
          appendLog('system', `socket error — ${detail}`);
        },
        onclose: async (evt) => {
          appendLog('system', `closed ${evt.reason || '(no reason)'} (${evt.code})`);
          session = null;
          setListeningUi(false);
          if (micDispose) await micDispose().catch(() => {});
          micDispose = null;
          await pcmOut.teardown();
          setStatus(false);
        },
      },
    });
    setStatus(true);

    try {
      const chain = await startMicPump((pcm) => {
        if (!session) return;
        session.sendRealtimeInput({
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: toBase64Binary(pcm),
          },
        });
      });
      await chain.ctx.resume().catch(() => {});
      micDispose = async () => teardownMic(chain);
      setListeningUi(true);
    } catch (err) {
      appendLog(
        'system',
        `Microphone required for this demo: ${err instanceof Error ? err.message : String(err)}`
      );
      await disconnect();
    }
  } catch (err) {
    await disconnect();
    const msg = err instanceof Error ? err.message : String(err);
    appendLog('system', `Connect failed: ${msg}`);
  }
}

function restoreLogHint() {
  const n = document.createElement('div');
  n.className = 'line muted';
  n.textContent = 'Conversation log begins after you connect and allow the microphone.';
  return n;
}

function init() {
  btnConnect.addEventListener('click', () => connect());
  btnDisconnect.addEventListener('click', () => disconnect());
}

init();
