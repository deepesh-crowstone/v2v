import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const DIST = join(process.cwd(), 'dist');

// Vertex AI Live config. The native-audio Vertex model is project-scoped and
// authenticated with Google Cloud credentials (service account / ADC), so the
// Live session is opened here on the server and proxied to the browser.
const MODEL = process.env.LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || '';
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const VOICE = process.env.LIVE_VOICE || 'Puck';

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Build google-auth options. A service-account JSON can be supplied inline via
 * GOOGLE_APPLICATION_CREDENTIALS_JSON (handy for Railway env vars); otherwise we
 * fall back to Application Default Credentials (e.g. the file path in
 * GOOGLE_APPLICATION_CREDENTIALS, or `gcloud auth application-default login`).
 */
function buildAuthOptions() {
  const inlineJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inlineJson && inlineJson.trim()) {
    let credentials;
    try {
      credentials = JSON.parse(inlineJson);
    } catch {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is set but is not valid JSON.');
    }
    return {
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    };
  }
  return undefined;
}

let aiClient = null;
function getVertexClient() {
  if (!PROJECT) {
    throw new Error('GOOGLE_CLOUD_PROJECT is not set — required for Vertex AI.');
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      vertexai: true,
      project: PROJECT,
      location: LOCATION,
      googleAuthOptions: buildAuthOptions(),
    });
  }
  return aiClient;
}

function indexHtml() {
  return readFileSync(join(DIST, 'index.html'), 'utf8');
}

function assetPath(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  return join(DIST, safePath);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(indexHtml());
    return;
  }

  try {
    const file = assetPath(url.pathname);
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');

    res.writeHead(200, {
      'cache-control': url.pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
      'content-type': types[extname(file)] || 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// --- Live API proxy: browser <-> this server <-> Vertex AI ---------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (pathname === '/live') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function errToText(e) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const maybe = /** @type {{ message?: unknown, reason?: unknown }} */ (e);
    if (typeof maybe.message === 'string') return maybe.message;
    if (typeof maybe.reason === 'string') return maybe.reason;
  }
  return String(e);
}

wss.on('connection', async (client) => {
  /** @type {import('@google/genai').Session | null} */
  let session = null;

  const sendJson = (obj) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(obj));
    }
  };

  try {
    const ai = getVertexClient();
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: VOICE },
          },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => sendJson({ type: 'open' }),
        onmessage: (message) => sendJson({ type: 'message', message }),
        onerror: (e) => sendJson({ type: 'error', detail: errToText(e) }),
        onclose: (e) => {
          sendJson({ type: 'closed', code: e?.code ?? null, reason: e?.reason ?? '' });
          try {
            client.close();
          } catch {
            /* noop */
          }
        },
      },
    });
    sendJson({ type: 'ready', model: MODEL });
  } catch (err) {
    sendJson({ type: 'error', detail: errToText(err) });
    try {
      client.close();
    } catch {
      /* noop */
    }
    return;
  }

  client.on('message', (raw) => {
    if (!session) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === 'audio' && typeof msg.data === 'string') {
        session.sendRealtimeInput({
          audio: { mimeType: msg.mimeType || 'audio/pcm;rate=16000', data: msg.data },
        });
      } else if (msg.type === 'audioStreamEnd') {
        session.sendRealtimeInput({ audioStreamEnd: true });
      }
    } catch (err) {
      sendJson({ type: 'error', detail: errToText(err) });
    }
  });

  const closeSession = () => {
    if (session) {
      try {
        session.close();
      } catch {
        /* noop */
      }
      session = null;
    }
  };

  client.on('close', closeSession);
  client.on('error', closeSession);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
  console.log(`Vertex AI: model=${MODEL} project=${PROJECT || '(unset!)'} location=${LOCATION}`);
  if (!PROJECT) {
    console.warn('GOOGLE_CLOUD_PROJECT is not set — /live connections will fail until it is.');
  }
});
