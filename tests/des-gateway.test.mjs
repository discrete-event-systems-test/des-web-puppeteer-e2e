import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test, { after, before } from 'node:test';
import puppeteer from 'puppeteer';
import { startFixture, stopFixture } from './support/fixture.mjs';
import {
  fetchTarget,
  gatewayCookie,
  pathForTarget,
  resolveTarget,
  usesServiceLocalPaths,
} from './support/target.mjs';

const ROUTES = [
  ['/des/', /discrete|simulation|model|DES/i],
  ['/des/models', /model|simulation/i],
  ['/des/games/soccer', /soccer|match|tournament/i],
  ['/des/games/elevator', /elevator|floor|dispatch/i],
  ['/des/tools/routing', /routing|route|solver/i],
  ['/des/labs/factory-floor-track3t', /factory|track|floor|3t/i],
];

let target;
let browser;
let page;
let fixtureStarted = false;

function targetUrl(publicPath) {
  return `${target.baseURL}${pathForTarget(publicPath, target.mode)}`;
}

function targetFetch(publicPath) {
  return fetchTarget(target.baseURL, pathForTarget(publicPath, target.mode), {
    mountPrefix: usesServiceLocalPaths(target.mode),
  });
}

before(async () => {
  await fs.mkdir('test-results/screenshots', { recursive: true });
  if (process.env.DES_FORCE_FIXTURE === '1') {
    target = await startFixture();
    fixtureStarted = true;
  } else {
    try {
      target = await resolveTarget();
    } catch (error) {
      console.warn(`Deployed DES target unavailable; using verified fixture: ${error.message}`);
      target = await startFixture();
      fixtureStarted = true;
    }
  }
  await fs.writeFile('test-results/target.json', `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  if (usesServiceLocalPaths(target.mode)) {
    await page.setExtraHTTPHeaders({ 'X-Forwarded-Prefix': '/des' });
  }
  const cookie = gatewayCookie(target.baseURL, target.mode);
  if (cookie) await page.setCookie(cookie);
});

after(async () => {
  if (browser) await browser.close();
  if (fixtureStarted) await stopFixture();
});

test('target discovery produced auditable evidence', () => {
  assert.match(target.baseURL, /^https?:\/\//);
  assert.ok(['internal', 'public-authenticated', 'public-open', 'public-auth-boundary', 'fixture'].includes(target.mode));
});

test('public gateway redirects unauthenticated browsers to the login surface', async (context) => {
  if (target.mode !== 'public-auth-boundary') return context.skip('Target provides full DES access');
  const response = await page.goto(targetUrl('/des/'), { waitUntil: 'domcontentloaded' });
  assert.ok(response);
  assert.match(page.url(), /\/auth(?:\?|$)/);
  const text = await page.$eval('body', (body) => body.innerText);
  assert.match(text, /auth|passphrase|sign in/i);
  await page.screenshot({ path: 'test-results/screenshots/auth-boundary.png', fullPage: true });
});

test('canonical DES pages render through a real Chromium browser', async (context) => {
  if (target.mode === 'public-auth-boundary') return context.skip('Public target is intentionally unauthenticated');
  for (const [path, hint] of ROUTES) {
    const response = await page.goto(targetUrl(path), { waitUntil: 'domcontentloaded' });
    assert.ok(response, `missing response for ${path}`);
    assert.ok(response.status() < 400, `${path} returned ${response.status()}`);
    const text = await page.$eval('body', (body) => body.innerText);
    assert.match(text, hint, `${path} did not expose its expected domain language`);
    assert.doesNotMatch(text, /application error|internal server error|panicked at/i);
  }
  await page.screenshot({ path: 'test-results/screenshots/des-home.png', fullPage: true });
});

test('catalog exposes canonical routes and repository ownership', async (context) => {
  if (target.mode === 'public-auth-boundary') return context.skip('Public target is intentionally unauthenticated');
  const response = await targetFetch('/des/api/v1/catalog');
  assert.equal(response.status, 200);
  for (const [path] of ROUTES) assert.match(response.body, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(response.body, /discrete-event-systems|des-web/i);
});

test('defensive headers survive the gateway and service boundary', async () => {
  const path = target.mode === 'public-auth-boundary' ? '/auth?return=/des/' : '/des/';
  const response = await targetFetch(path);
  assert.equal(String(response.headers['x-content-type-options'] ?? '').toLowerCase(), 'nosniff');
  assert.match(String(response.headers['x-frame-options'] ?? ''), /sameorigin|deny/i);
});

test('compatibility service alias reaches the canonical application in-cluster', async (context) => {
  if (target.mode !== 'internal') return context.skip('Live Service comparison runs only when cluster networking is available');
  const canonical = await fetchTarget('http://dd-des-web.default.svc.cluster.local:8130', '/api/v1/catalog');
  const compatibility = await fetchTarget('http://dd-des-simulator.default.svc.cluster.local:8099', '/api/v1/catalog');
  assert.equal(canonical.status, 200);
  assert.equal(compatibility.status, 200);
  assert.deepEqual(JSON.parse(compatibility.body), JSON.parse(canonical.body));
});
