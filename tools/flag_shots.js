'use strict';
/**
 * Capture before/after screenshots of a page in the PAGE-LEVEL maintenance
 * state. Serves docs/ over HTTP, launches headless Chrome via CDP, navigates to
 * the target page, captures the LIVE (before) state, then forces the page key to
 * 'maintenance' via WildlifeFlags.applyPanelFlags and captures the AFTER state.
 *
 * Usage: node tools/flag_shots.js <page-file> <page-key> <out-dir>
 *   e.g. node tools/flag_shots.js dispatcher.html page-dispatcher .artifacts/shots
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const DOCS = path.resolve(__dirname, '..', 'docs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PAGE_FILE = process.argv[2] || 'dispatcher.html';
const PAGE_KEY = process.argv[3] || 'page-dispatcher';
const OUT_DIR = process.argv[4] || path.resolve(__dirname, '..', '.artifacts', 'shots');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function staticServer() {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/' + PAGE_FILE;
    const fp = path.join(DOCS, urlPath);
    if (!fp.startsWith(DOCS)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

function getFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve) => { ws.addEventListener('open', () => resolve()); });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  function send(method, params) {
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  }
  return { ready, send, close: () => ws.close() };
}

async function evalExpr(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function shoot(client, w, outPath) {
  const h = await evalExpr(client, 'document.documentElement.scrollHeight');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: Math.min(h, 4000), deviceScaleFactor: 2, mobile: true,
  });
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('wrote ' + outPath);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = staticServer();
  const port = await getFreePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + port + '/' + PAGE_FILE;

  const dbgPort = await getFreePort();
  const userDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + dbgPort,
    '--user-data-dir=' + userDir, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await httpGetJSON('http://127.0.0.1:' + dbgPort + '/json/list');
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
      target = null;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('Chrome devtools target not found');

  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  const W = 420;
  await client.send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: true });
  await client.send('Page.navigate', { url: baseUrl });
  await new Promise((r) => setTimeout(r, 1800));

  const base = PAGE_KEY.replace(/^page-/, '');
  // BEFORE — live render.
  await shoot(client, W, path.join(OUT_DIR, 'before_' + base + '_live.png'));

  // AFTER — force this page key to maintenance and re-apply.
  const applied = await evalExpr(client, `(function(){
    var f = window.WildlifeFlags;
    f.pages['${PAGE_KEY}'] = { prod: 'maintenance', dev: 'maintenance' };
    var r = f.applyPanelFlags({ hostname: 'wildlifeinneed.github.io' });
    window.scrollTo(0,0);
    return JSON.stringify(r);
  })()`);
  console.log('applied: ' + applied);
  await new Promise((r) => setTimeout(r, 400));
  await shoot(client, W, path.join(OUT_DIR, 'after_' + base + '_maintenance.png'));

  client.close();
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

main().catch((e) => { console.error('SHOT ERROR:', e); process.exit(1); });
