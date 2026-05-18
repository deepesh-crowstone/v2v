import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const DIST = join(process.cwd(), 'dist');

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function indexHtml() {
  const key = process.env.GEMINI_API_KEY || '';
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const script = `<script>window.__GEMINI_API_KEY__=${JSON.stringify(key)};</script>`;
  return html.replace(/<body[^>]*>/i, (tag) => `${tag}${script}`);
}

function assetPath(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  return join(DIST, safePath);
}

createServer(async (req, res) => {
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
}).listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
});
