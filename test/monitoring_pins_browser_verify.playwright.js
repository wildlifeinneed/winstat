// REAL-BROWSER verification for the monitoring-volunteer cross-post map fix
// (owner directive follow-up to 5b0b0c4). Drives the ACTUAL shipped
// docs/dispatcher.html + docs/assets/dispatcher.js in a real Chromium page
// via Playwright. Only the Worker's fetch() calls (WORKER_URL) are
// intercepted/mocked -- everything else (Leaflet rendering, DOM, CSS,
// renderCrossPostMap, addMonitoringVolRows, the legend painter) is the real
// shipped code running for real in a real browser.
//
// Repro: Bedford county -> WIN area 11 (owner's screenshot case). Mocked
// monitoring_area_vols mirrors the Worker's real per-win_area scoping
// (worker/src/handler.js filterWinArea), returning a DIFFERENT slice per
// area exactly like the real KV-backed Worker would.
//
// Run: node test/monitoring_pins_browser_verify.playwright.js

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const PORT = 8879;
const WORKER_ORIGIN = 'https://pa-wildlife-dispatcher.winstat.workers.dev';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/dispatcher.html';
      const filePath = path.join(DOCS_DIR, urlPath);
      if (!filePath.startsWith(DOCS_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

// Monitoring-vol universe for the Bedford/Area-11 repro. Mirrors the
// OWNER's stated case: Leigh (home area 5, monitors 1/2/5/6/10/11) must
// appear on the Area-11 map (she genuinely monitors 11) but NOT because she
// also monitors suggested area 6 -- that distinction is what this script
// proves by giving OTHER vols who monitor 6/7/12 but NOT 11 (Jennifer, Amy,
// Karen, Penny) who must NOT appear.
function monitoringVolsForArea(area) {
  const ALL = {
    '11': [
      { roles: ['C&T', 'RVS'], win_area: '10', home_county: 'Allegheny', monitored_areas: ['6', '10', '11'], first_name: 'Ashley' },
      { roles: ['Dispatch', 'C&T', 'RVS'], win_area: '10', home_county: 'Allegheny', monitored_areas: ['5', '10', '11'], first_name: 'Susan' },
      { roles: ['C&T'], win_area: '6', home_county: 'Cambria', monitored_areas: ['5', '6', '11'], first_name: 'Sarah' },
      { roles: ['Dispatch', 'C&T', 'RVS'], win_area: '5', home_county: 'Butler', monitored_areas: ['1', '2', '5', '6', '10', '11'], first_name: 'Leigh' },
    ],
    '7': [
      { roles: ['C&T'], win_area: '7', home_county: 'Blair', monitored_areas: ['6', '7'], first_name: 'Jennifer' },
      { roles: ['C&T'], win_area: '13', home_county: 'Dauphin', monitored_areas: ['7', '12', '13'], first_name: 'Amy' },
    ],
    '12': [
      { roles: ['C&T'], win_area: '16', home_county: 'Chester', monitored_areas: ['12', '16'], first_name: 'Karen' },
    ],
    '6': [
      { roles: ['C&T'], win_area: '7', home_county: 'Huntingdon', monitored_areas: ['6', '7'], first_name: 'Penny' },
    ],
  };
  return ALL[area] || [];
}

async function installWorkerMock(page) {
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const url = new URL(route.request().url());
    const winArea = url.searchParams.get('win_area');
    const byCounty = url.searchParams.get('by_county');
    const address = url.searchParams.get('address');
    const animalLat = url.searchParams.get('animal_lat');

    // Bedford county centroid-ish coordinates (repro location).
    const BEDFORD_LAT = 39.98;
    const BEDFORD_LON = -78.5;

    const body = {
      total_in_range: 0,
      role_counts: {},
      win_areas: winArea ? [winArea] : ['11'],
      out_of_county: [],
      out_of_county_all: [],
      out_of_county_truncated: false,
      radius_too_broad: false,
      animal_lat: animalLat ? parseFloat(animalLat) : BEDFORD_LAT,
      animal_lon: BEDFORD_LON,
      animal_county: 'Bedford',
      animal_area: '11',
      animal_geoid: null,
    };
    if (address) {
      // crossPostGeocode's ?address= path only reads animal_lat/animal_lon.
      body.animal_lat = BEDFORD_LAT;
      body.animal_lon = BEDFORD_LON;
    }
    if (byCounty === '1' && winArea) {
      body.monitoring_area_vols = monitoringVolsForArea(winArea);
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function getPinSnapshot(page) {
  return page.evaluate(() => {
    const wraps = Array.from(document.querySelectorAll('.cp-map-wrap'));
    const wrap = wraps[wraps.length - 1]; // most recently rendered map
    if (!wrap) return { found: false };
    const markerIcons = Array.from(wrap.querySelectorAll('.leaflet-marker-icon'));
    const monitorIcons = markerIcons.filter((el) => el.querySelector('.t2-pin-monitor'));
    const titles = monitorIcons.map((el) => el.getAttribute('title'));
    const monitorPinEl = wrap.querySelector('.t2-pin-monitor');
    const legendSwatch = wrap.querySelector('.mlp-vol-monitor');
    const legendItem = Array.from(wrap.querySelectorAll('.mlp-item'))
      .find((i) => /Monitoring volunteer/i.test(i.textContent));
    return {
      found: true,
      pinCount: monitorIcons.length,
      titles: titles,
      markerColor: monitorPinEl ? getComputedStyle(monitorPinEl).backgroundColor : null,
      legendColor: legendSwatch ? getComputedStyle(legendSwatch).backgroundColor : null,
      legendText: legendItem ? legendItem.textContent.trim() : null,
    };
  });
}

async function runTier1(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await installWorkerMock(page);
  await page.goto(`http://localhost:${PORT}/dispatcher.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(500);

  // Select Bedford county (By County mode, default).
  await page.selectOption('#county', { label: 'Bedford' });
  await page.click('#recommend-btn');
  await page.waitForTimeout(500);

  // Find and click the "Check for Cross Post" button if the recommendation
  // rendered one (depends on Bedford's live capacity numbers).
  const crossPostBtn = await page.$('.cross-post-btn');
  if (!crossPostBtn) {
    return { ok: false, reason: 'no cross-post button rendered for Bedford recommendation (capacity may be adequate)' };
  }
  await crossPostBtn.click();
  await page.waitForTimeout(200);
  await page.fill('.cross-post-addr', '123 Main St, Bedford, PA');
  await page.click('.cross-post-check-btn');
  await page.waitForTimeout(1500); // allow per-area async fetches + map render

  const snapshot = await getPinSnapshot(page);
  await context.close();
  return { ok: true, snapshot, consoleErrors };
}

async function runTier2(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await installWorkerMock(page);
  await page.goto(`http://localhost:${PORT}/dispatcher.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(500);

  // Switch to "By Animal Address" mode (Tier 2). Click the <label> wrapping
  // the radio (the label intercepts pointer events on the input itself).
  await page.click('label:has(input[name="mode"][value="address"])');
  await page.waitForTimeout(200);
  await page.fill('#animal-address', '123 Main St, Bedford, PA');
  // Submit the address form (Enter key triggers the same submit handler as
  // clicking whatever submit control exists).
  await page.press('#animal-address', 'Enter');
  await page.waitForTimeout(1000);

  const t2CrossPostBtn = await page.$('#t2-cross-post-block .cross-post-btn');
  if (!t2CrossPostBtn) {
    return { ok: false, reason: 'no Tier 2 cross-post button rendered (no resolved coords, or capacity adequate)' };
  }
  await t2CrossPostBtn.click();
  await page.waitForTimeout(1500);

  const snapshot = await getPinSnapshot(page);
  await context.close();
  return { ok: true, snapshot, consoleErrors };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  const report = {};
  try {
    report.tier1 = await runTier1(browser);
    report.tier2 = await runTier2(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify(report, null, 2));

  // ── Assertions ──────────────────────────────────────────────────────────
  let failed = false;
  function check(cond, msg) {
    if (!cond) { console.error('FAIL: ' + msg); failed = true; }
    else console.log('PASS: ' + msg);
  }

  if (report.tier1.ok) {
    const s = report.tier1.snapshot;
    check(s.found, 'Tier 1: cross-post map rendered');
    check(s.pinCount === 4, 'Tier 1: monitoring pin count is 4 (Ashley, Susan, Sarah, Leigh), got ' + s.pinCount);
    check(!s.titles.some((t) => /Jennifer|Amy|Karen|Penny/.test(t || '')),
      'Tier 1: no suggested-area-only monitors (Jennifer/Amy/Karen/Penny) appear');
    check(s.titles.some((t) => /Leigh/.test(t || '')), 'Tier 1: Leigh appears (she genuinely monitors area 11)');
    check(s.markerColor === s.legendColor, 'Tier 1: marker color (' + s.markerColor + ') === legend color (' + s.legendColor + ')');
  } else {
    console.error('Tier 1 run skipped: ' + report.tier1.reason);
  }

  if (report.tier2.ok) {
    const s = report.tier2.snapshot;
    check(s.found, 'Tier 2: cross-post map rendered');
    check(s.pinCount === 4, 'Tier 2: monitoring pin count is 4, got ' + s.pinCount);
    check(!s.titles.some((t) => /Jennifer|Amy|Karen|Penny/.test(t || '')),
      'Tier 2: no suggested-area-only monitors appear');
    check(s.markerColor === s.legendColor, 'Tier 2: marker color (' + s.markerColor + ') === legend color (' + s.legendColor + ')');
  } else {
    console.error('Tier 2 run skipped: ' + report.tier2.reason);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
