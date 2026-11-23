import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3333);

const TEMPLATES = {
  cuadrado:  { file: 'plantillas/post-cuadrado-producto.html', width: 1080, height: 1080 },
  vertical:  { file: 'plantillas/post-vertical-producto.html', width: 1080, height: 1350 },
  story:     { file: 'plantillas/story-promo.html',            width: 1080, height: 1920 },
  vitrina:   { file: 'plantillas/post-vitrina-pro.html',       width: 1080, height: 1080 },
  coleccion: { file: 'plantillas/post-coleccion-grid.html',    width: 1080, height: 1080 },
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No se encontró Chrome ni Edge.');
}

const BROWSER_PATH = findBrowser();
const pendingRenders = new Map();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const urlPath = decodeURIComponent(urlObj.pathname);

    if (req.method === 'GET' && urlPath === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'studio.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && urlPath.startsWith('/_job/')) {
      const id = urlPath.slice('/_job/'.length).replace('.html', '');
      const html = pendingRenders.get(id);
      if (!html) {
        res.writeHead(404);
        res.end('Job expired');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/render') {
      const body = await readJsonBody(req);
      const tplKey = (body.template || 'cuadrado').toLowerCase();
      const tpl = TEMPLATES[tplKey];
      if (!tpl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plantilla inválida' }));
        return;
      }

      const rawHtml = fs.readFileSync(path.join(__dirname, tpl.file), 'utf8');
      const injectedHtml = rawHtml
        .replace('<head>', `<head>\n<base href="/plantillas/">`)
        .replace(
          '</body>',
          `<script>window.__MAKORA_DATA__ = ${JSON.stringify(body.data || {})}; if (window.applyMakoraData) window.applyMakoraData(window.__MAKORA_DATA__);</script>\n</body>`
        );

      const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingRenders.set(jobId, injectedHtml);

      const fileName = `makora-${tplKey}-${Date.now()}.png`;
      const outPath = path.join(__dirname, 'salida', fileName);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'makora-chrome-'));
      try {
        await execFileAsync(BROWSER_PATH, [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${tmpProfile}`,
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          `--window-size=${tpl.width},${tpl.height}`,
          `--screenshot=${outPath}`,
          `http://127.0.0.1:${PORT}/_job/${jobId}.html`,
        ], { timeout: 25000 });
      } finally {
        pendingRenders.delete(jobId);
        fs.rmSync(tmpProfile, { recursive: true, force: true });
      }

      const png = fs.readFileSync(outPath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Saved-Path': `salida/${fileName}`,
      });
      res.end(png);
      return;
    }

    // Serve workspace static files
    const safeRel = urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(__dirname, safeRel);
    if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Makora Studio listo en: http://127.0.0.1:${PORT}`);
});
