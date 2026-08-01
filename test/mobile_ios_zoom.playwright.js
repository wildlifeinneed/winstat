// REAL-BROWSER regression check for the iOS WebKit "zoom on input focus"
// mobile-overflow bug (all iOS browsers -- Safari, DuckDuckGo, Chrome,
// Firefox, Edge -- are required by Apple to embed WebKit, so they all share
// this behavior; it is not Safari-specific).
//
// Root cause: iOS WebKit auto-zooms the whole visual viewport when a
// focused <input>/<textarea> has a COMPUTED font-size under 16px. That is
// what produced the reported symptom ("once I click cross post the frame is
// lost ... requires a pinch to get it back") -- the zoom fires on FOCUS,
// before any map exists, and a pinch gesture is the natural way a user
// resets pinch-to-zoom back to 1x. Downstream effects (map looking
// clipped, fullscreen exit control looking unreachable) are consequences of
// the page being zoomed in, not independent bugs.
//
// jsdom (used by test/dispatcher_dom.test.js) has no layout/zoom engine and
// cannot reproduce this, which is exactly why the prior CSS source-contract
// tests could not have caught it. This script drives the REAL, DEPLOYED
// page in an actual browser engine and reads window.visualViewport, which
// is the same API iOS exposes.
//
// NOT wired into `npm test` (adds a ~180MB non-default dependency
// (Playwright + browser binaries) to the default fast path). Runnable with:
//
//   npm run test:mobile-zoom
//
// or directly:
//
//   node test/mobile_ios_zoom.playwright.js [url]
//
// Primary engine is WEBKIT (the only Playwright engine that reproduces iOS
// zoom-on-focus behavior -- Chromium does NOT implement this, so a Chromium
// pass/fail here cannot confirm or refute the diagnosis on its own).
// Chromium is run second, purely as an Android/desktop-engine sanity check
// (no overflow, no crash), and its visualViewport.scale is expected to stay
// 1 regardless of the fix (Chromium never zoomed in the first place).

const { webkit, chromium } = require('playwright');

const URL = process.argv[2] || 'https://wildlifeinneed.github.io/winstat/dispatcher.html';

async function measureViewport(page) {
  return page.evaluate(() => ({
    scale: window.visualViewport ? window.visualViewport.scale : null,
    width: window.visualViewport ? window.visualViewport.width : null,
    innerWidth: window.innerWidth,
  }));
}

async function driveToCrossPostInput(page) {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.selectOption('#county', 'Bedford');
  await page.waitForTimeout(1500);
  await page.click('#recommend-btn');
  await page.waitForTimeout(2500);
  await page.click('.cross-post-btn');
  await page.waitForTimeout(400);
}

async function driveToTier2Input(page) {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="mode"][value="address"]');
    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(500);
}

async function checkInputFocusZoom(browser, engineName, driveFn, selector, label) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await driveFn(page);

  const before = await measureViewport(page);
  await page.focus(selector);
  await page.waitForTimeout(400); // allow WebKit's zoom animation to settle
  const onFocus = await measureViewport(page);
  await page.evaluate((sel) => document.querySelector(sel).blur(), selector);
  await page.waitForTimeout(400);
  const afterBlur = await measureViewport(page);

  console.log(`\n[${engineName}] ${label} (${selector})`);
  console.log(`  before focus: scale=${before.scale} visualViewport.width=${before.width} innerWidth=${before.innerWidth}`);
  console.log(`  ON FOCUS:     scale=${onFocus.scale} visualViewport.width=${onFocus.width} innerWidth=${onFocus.innerWidth}`);
  console.log(`  after blur:   scale=${afterBlur.scale} visualViewport.width=${afterBlur.width} innerWidth=${afterBlur.innerWidth}`);

  await context.close();
  return { before, onFocus, afterBlur };
}

async function main() {
  console.log('Target URL:', URL);
  const results = { webkit: {}, chromium: {} };

  console.log('\n================ WEBKIT (iOS engine -- primary) ================');
  const wk = await webkit.launch();
  try {
    results.webkit.crossPost = await checkInputFocusZoom(
      wk, 'WebKit', driveToCrossPostInput, '.cross-post-addr', 'Tier 1 cross-post address input');
    results.webkit.tier2 = await checkInputFocusZoom(
      wk, 'WebKit', driveToTier2Input, '#animal-address', 'Tier 2 animal address input');
    results.webkit.radius = await checkInputFocusZoom(
      wk, 'WebKit', driveToTier2Input, '#radius-mi', 'Tier 2 radius input');
  } finally {
    await wk.close();
  }

  console.log('\n================ CHROMIUM (secondary sanity check) ================');
  const cr = await chromium.launch();
  try {
    results.chromium.crossPost = await checkInputFocusZoom(
      cr, 'Chromium', driveToCrossPostInput, '.cross-post-addr', 'Tier 1 cross-post address input');
    results.chromium.tier2 = await checkInputFocusZoom(
      cr, 'Chromium', driveToTier2Input, '#animal-address', 'Tier 2 animal address input');
  } finally {
    await cr.close();
  }

  console.log('\n================ VERDICT ================');
  let anyWebkitZoom = false;
  for (const [key, r] of Object.entries(results.webkit)) {
    if (r.onFocus.scale && r.onFocus.scale > 1.01) {
      console.log(`WEBKIT ${key}: scale went to ${r.onFocus.scale} on focus -- ZOOM REPRODUCED.`);
      anyWebkitZoom = true;
    } else {
      console.log(`WEBKIT ${key}: scale stayed ~1 (${r.onFocus.scale}) on focus -- no zoom observed.`);
    }
  }
  if (anyWebkitZoom) {
    console.log('\n=> WebKit REPRODUCED iOS zoom-on-focus. This confirms the diagnosis directly (not just via the computed-font-size audit).');
    process.exitCode = 1; // signal "still broken" to a caller checking exit code, pre-fix
  } else {
    console.log('\n=> WebKit did NOT show scale > 1 on focus in this run. Falling back to the computed-font-size');
    console.log('   audit (test/dispatcher_dom.test.js / font_audit tooling) as the primary evidence for the fix,');
    console.log('   since a >=16px computed font-size is what prevents WebKit from ever triggering the zoom,');
    console.log('   independent of whether this harness\'s headless WebKit build enacts the animation the same');
    console.log('   way a real iPhone does.');
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
