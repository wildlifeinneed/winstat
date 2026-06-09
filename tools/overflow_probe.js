'use strict';
/**
 * Headless overflow probe for the dispatcher ADDRESS view.
 *
 * Serves docs/ over HTTP, launches Chrome headless via CDP, navigates to
 * dispatcher.html, switches to Address mode, injects a MOCKED Worker response
 * (aggregate cards + #ctx-list rows + recommended actions), then at each phone
 * width measures scrollWidth vs innerWidth and enumerates every element whose
 * rendered box exceeds the viewport.
 *
 * Usage: node tools/overflow_probe.js [--shot OUTDIR]
 *   --shot OUTDIR  capture PNG screenshots at 360px into OUTDIR
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const DOCS = path.resolve(__dirname, '..', 'docs');
const WIDTHS = [320, 360, 375, 390, 430];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const shotIdx = args.indexOf('--shot');
const SHOT_DIR = shotIdx !== -1 ? args[shotIdx + 1] : null;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function staticServer() {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/dispatcher.html';
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

// Minimal CDP client over the DevTools WebSocket (Node 26 has global WebSocket).
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
  if (r.exceptionDetails) {
    throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

// The mock Worker payload installed before page scripts run. Standalone address
// lookup => aggregate + out_of_county context rows (varied roles, long county
// names to stress text wrapping) + recommended actions.
const MOCK_AGG = {
  total_in_range: 18,
  role_counts: { 'C&T': 7, 'RVS C&T': 3, 'COURIER': 8 },
  win_areas: ['10', '11', '5', '1', '2', '12', '13'],
  animal_county: 'Northumberland',
  animal_area: '5',
  out_of_county: [
    { roles: ['C&T'], distance_mi: 4.2, win_area: '10', county: 'Allegheny' },
    { roles: ['RVS C&T', 'COURIER'], distance_mi: 9.8, win_area: '11', county: 'Westmoreland' },
    { roles: ['COURIER'], distance_mi: 14.1, win_area: '5', county: 'Northumberland' },
    { roles: ['C&T', 'RVS C&T', 'COURIER'], distance_mi: 17.6, win_area: '1', county: 'Northampton' },
    { roles: ['COURIER'], distance_mi: 19.4, win_area: '2', county: 'Lackawanna' },
    // Pathological unbreakable token to expose any row lacking overflow-wrap.
    { roles: ['C&T'], distance_mi: 21.7, win_area: '14', county: (process.env.PROBE_PATHO ? 'NorthumberlandwestmorelandlackawannaphiladelphiaalleghenyXX' : 'Lycoming') },
  ],
};

const INSTALL_MOCK = `
(function () {
  var realFetch = window.fetch;
  var MOCK = ${JSON.stringify(MOCK_AGG)};
  window.fetch = function (url, opts) {
    var u = String(url);
    if (u.indexOf('autocomplete=') !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ suggestions: [
        { label: '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213', lat: 40.4443, lon: -79.9569 },
        { label: '1234 Northumberland Boulevard Northeast, Mechanicsburg, Pennsylvania 17050', lat: 40.2, lon: -77.0 }
      ] }); } });
    }
    if (u.indexOf('mode=rehabber_distances') !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ source: 'haversine', distances: [] }); } });
    }
    if (u.indexOf('workers.dev') !== -1 || u.indexOf('address=') !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(MOCK); } });
    }
    // local data/*.json on init
    if (u.indexOf('.json') !== -1 || u.indexOf('.geojson') !== -1) {
      return realFetch(url, opts);
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  };
})();
`;

const POPULATE = `
(async function () {
  // switch to address mode
  var amode = document.querySelector('input[name="mode"][value="address"]');
  amode.checked = true;
  amode.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  document.querySelector('#address-btn').click();
  // wait for the async render to land (poll until result is shown)
  for (var i = 0; i < 60; i++) {
    if (document.querySelector('#address-result').style.display === 'block') break;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  return document.querySelector('#address-result').style.display;
})();
`;

const MEASURE = `
(function () {
  function rectOf(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { right: Math.round(r.right*100)/100, width: Math.round(r.width*100)/100, left: Math.round(r.left*100)/100 };
  }
  // Capture key suspects in the page's NATURAL state (clip in place) first.
  var natural = {
    iw: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    cardsGrid: rectOf('#address-result .cards-grid'),
    lastCard: rectOf('#address-result .cards-grid .cap-card:last-child'),
    ctxList: rectOf('#ctx-list'),
    lastCtxRow: rectOf('#ctx-list .ctx-row:last-child'),
    winAreas: rectOf('#agg-areas'),
    resolved: rectOf('#resolved-location'),
  };

  // Neutralize the overflow-x:hidden clip on html/body/main so the TRUE natural
  // document width and real element boxes are revealed (clipping would otherwise
  // clamp scrollWidth and getBoundingClientRect to the viewport, masking the
  // real offender). This is measurement-only; it does not persist.
  var unclip = document.createElement('style');
  unclip.id = '__probe_unclip__';
  unclip.textContent = 'html,body,main{overflow-x:visible !important;}';
  document.head.appendChild(unclip);

  var iw = window.innerWidth;
  var de = document.documentElement;
  var offenders = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.id === '__probe_unclip__') continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // allow 0.5px sub-pixel slack
    if (r.right > iw + 0.5 || r.left < -0.5) {
      var cs = getComputedStyle(el);
      offenders.push({
        sel: (el.tagName.toLowerCase() +
              (el.id ? '#' + el.id : '') +
              (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '')),
        left: Math.round(r.left * 100) / 100,
        right: Math.round(r.right * 100) / 100,
        width: Math.round(r.width * 100) / 100,
        overflowPx: Math.round((r.right - iw) * 100) / 100,
        minWidth: cs.minWidth,
        whiteSpace: cs.whiteSpace,
        flex: cs.flex,
        wordBreak: cs.overflowWrap + '/' + cs.wordBreak,
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  // sort by overflow desc, keep deepest/widest
  offenders.sort(function (a, b) { return b.overflowPx - a.overflowPx; });
  // Also report the single widest right-edge among ALL elements (even if within
  // tolerance) so grid-rounding near the edge is visible.
  var maxRight = 0, maxSel = '';
  for (var j = 0; j < all.length; j++) {
    var rr = all[j].getBoundingClientRect();
    if (rr.width === 0 && rr.height === 0) continue;
    if (rr.right > maxRight) { maxRight = rr.right; maxSel = (all[j].tagName.toLowerCase() + (all[j].id ? '#' + all[j].id : '') + (all[j].className && typeof all[j].className === 'string' ? '.' + all[j].className.trim().split(/\\s+/).join('.') : '')); }
  }
  // Targeted probe of the patho ctx-ctx span (longest unbreakable token row).
  var patho = null;
  var ctxSpans = document.querySelectorAll('#ctx-list .ctx-ctx');
  if (ctxSpans.length) {
    var last = ctxSpans[ctxSpans.length - 1];
    var pr = last.getBoundingClientRect();
    var pcs = getComputedStyle(last);
    patho = {
      text: (last.textContent || '').trim().slice(0, 50),
      right: Math.round(pr.right*100)/100, width: Math.round(pr.width*100)/100,
      overflowWrap: pcs.overflowWrap, wordBreak: pcs.wordBreak, minWidth: pcs.minWidth,
      scrollWidth: last.scrollWidth, clientWidth: last.clientWidth,
    };
  }
  return {
    innerWidth: iw,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    maxRight: Math.round(maxRight * 100) / 100,
    maxRightSel: maxSel,
    patho: patho,
    natural: natural,
    offenders: offenders.slice(0, 25),
  };
})();
`;

async function main() {
  const server = staticServer();
  const port = await getFreePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + port + '/dispatcher.html';

  const dbgPort = await getFreePort();
  const userDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--remote-debugging-port=' + dbgPort, '--user-data-dir=' + userDir,
    '--hide-scrollbars=false', 'about:blank',
  ], { stdio: 'ignore' });

  // wait for devtools endpoint + a real page target
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

  const results = [];
  // Register the Worker mock ONCE; it re-applies on every new document.
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_MOCK });
  // Warm-up navigation: the very first page load is slow (cold geojson fetch);
  // do a throwaway load so per-width timing below is consistent.
  await client.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await client.send('Page.navigate', { url: baseUrl });
  await new Promise((r) => setTimeout(r, 1500));

  for (const w of WIDTHS) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 800, deviceScaleFactor: 2, mobile: true,
    });
    await client.send('Page.navigate', { url: baseUrl });
    // wait for load + init (geojson fetch, county render) to settle
    await new Promise((r) => setTimeout(r, 1200));
    await evalExpr(client, POPULATE);
    if (process.env.PROBE_SELFTEST) {
      // Inject a deliberately-wide node to confirm the unclip+measure path
      // actually detects real overflow (guards against a false "all clean").
      await evalExpr(client, `(function(){
        var d = document.createElement('div');
        d.id = 'SELFTEST_WIDE';
        d.style.cssText = 'width:9999px;height:10px;';
        document.querySelector('#address-result').appendChild(d);
        return true;
      })()`);
    }
    const diag = await evalExpr(client, `(function(){
      return {
        resultShown: document.querySelector('#address-result').style.display,
        ctxBlock: document.querySelector('#ctx-block').style.display,
        ctxRows: document.querySelectorAll('#ctx-list .ctx-row').length,
        aggTotal: document.querySelector('#agg-total').textContent,
        actions: document.querySelectorAll('#agg-actions .action-line').length,
        winChips: document.querySelectorAll('#agg-areas .win-chip').length,
        addrError: document.querySelector('#address-error').style.display,
      };
    })()`);
    const m = await evalExpr(client, MEASURE);
    // Second pass: open the WIN Areas map + reveal nearest-rehabber list, then
    // re-measure (these are address-view elements a real user can expand).
    await evalExpr(client, `(function(){
      var mp = document.querySelector('#map-panel'); if (mp) mp.open = true;
      var rt = document.querySelector('#rehab-toggle');
      if (rt && document.querySelector('#rehab-block').style.display !== 'none') rt.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const mExpanded = await evalExpr(client, MEASURE);

    // Third pass: open the autocomplete dropdown with long suggestions and
    // measure (the dropdown is an address-view element a real user sees while
    // typing). Re-navigate-free: trigger the input handler directly.
    await evalExpr(client, `(async function(){
      var inp = document.querySelector('#animal-address');
      inp.value = '1234 Northumberland';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(function(r){ setTimeout(r, 600); });
      return document.querySelector('#address-suggestions').hidden;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const acDiag = await evalExpr(client, `(function(){
      var l = document.querySelector('#address-suggestions');
      return { hidden: l ? l.hidden : null, items: document.querySelectorAll('#address-suggestions .ac-item').length };
    })()`);
    const mAutocomplete = await evalExpr(client, MEASURE);
    results.push({ width: w, diag, acDiag, base: m, expanded: mExpanded, autocomplete: mAutocomplete });

    if (SHOT_DIR && w === 360) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      // full page height
      const metrics = await evalExpr(client, 'document.documentElement.scrollHeight');
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: Math.min(metrics, 4000), deviceScaleFactor: 2, mobile: true,
      });
      const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const outPath = path.join(SHOT_DIR, 'address_360_full.png');
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      // viewport-only top
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: 800, deviceScaleFactor: 2, mobile: true,
      });
      const shot2 = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, 'address_360_viewport.png'), Buffer.from(shot2.data, 'base64'));
    }
  }

  console.log(JSON.stringify(results, null, 2));
  client.close();
  chrome.kill();
  server.close();
  // give chrome a moment to die
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
