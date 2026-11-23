import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES = {
  cuadrado: { file: 'plantillas/post-cuadrado-producto.html', width: 1080, height: 1080 },
  vertical: { file: 'plantillas/post-vertical-producto.html', width: 1080, height: 1350 },
  story:    { file: 'plantillas/story-promo.html',            width: 1080, height: 1920 },
  vitrina:  { file: 'plantillas/post-vitrina-pro.html',       width: 1080, height: 1080 },
  coleccion:{ file: 'plantillas/post-coleccion-grid.html',    width: 1080, height: 1080 },
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
  throw new Error('No se encontró Chrome ni Edge instalado.');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      if (key === 'image' || key === 'images') {
        args.images = args.images || [];
        args.images.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
      } else {
        args[key] = val;
      }
    }
  }
  return args;
}

function toWebPath(p) {
  if (!p) return '';
  if (/^(https?:|data:)/i.test(p)) return p;
  const abs = path.isAbsolute(p) ? p : path.resolve(__dirname, p);
  const rel = path.relative(__dirname, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) {
    // Embed as data URI if outside workspace
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_TYPES[ext] || 'image/png';
    const b64 = fs.readFileSync(abs).toString('base64');
    return `data:${mime};base64,${b64}`;
  }
  return '/' + rel.split('/').map(encodeURIComponent).join('/');
}

async function renderJob(browserPath, job) {
  const tplKey = (job.template || 'cuadrado').toLowerCase();
  const tpl = TEMPLATES[tplKey];
  if (!tpl) {
    throw new Error(`Plantilla desconocida "${tplKey}". Usa: ${Object.keys(TEMPLATES).join(', ')}`);
  }

  const outPath = path.resolve(__dirname, job.out || `salida/makora-${tplKey}-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const data = { ...job };
  if (data.image) data.image = toWebPath(data.image);
  if (Array.isArray(data.images)) {
    data.images = data.images.map(toWebPath);
    if (!data.image && data.images.length > 0) data.image = data.images[0];
  }

  const tplHtmlPath = path.resolve(__dirname, tpl.file);
  const rawHtml = fs.readFileSync(tplHtmlPath, 'utf8');
  const injectedHtml = rawHtml
    .replace('<head>', `<head>\n<base href="/plantillas/">`)
    .replace('</body>', `<script>window.__MAKORA_DATA__ = ${JSON.stringify(data)}; if (window.applyMakoraData) window.applyMakoraData(window.__MAKORA_DATA__);</script>\n</body>`);

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/_render.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(injectedHtml);
      return;
    }
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
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const targetUrl = `http://127.0.0.1:${port}/_render.html`;

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'makora-chrome-'));
  try {
    await execFileAsync(
      browserPath,
      [
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
        targetUrl,
      ],
      { timeout: 25000 }
    );
  } finally {
    server.close();
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }

  console.log(`✔ Generado [${tplKey} ${tpl.width}x${tpl.height}]: ${path.relative(__dirname, outPath)}`);
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browserPath = findBrowser();

  if (args.config) {
    const cfgPath = path.resolve(__dirname, args.config);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : [parsed];
    for (const job of jobs) {
      await renderJob(browserPath, job);
    }
  } else {
    await renderJob(browserPath, args);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
