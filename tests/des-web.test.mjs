import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import puppeteer from 'puppeteer';
import { startFixture, stopFixture } from './support/fixture.mjs';

const DEPLOYED_BASE_URL = 'http://dd-des-web.default.svc.cluster.local:8130';
let baseURL;
let browser;
let fixtureStarted = false;

async function chooseBaseURL() {
  if (process.env.DES_FORCE_FIXTURE === '1') {
    fixtureStarted = true;
    return new URL((await startFixture()).baseURL);
  }
  if (process.env.DES_BASE_URL) return new URL(process.env.DES_BASE_URL);
  const deployed = new URL(DEPLOYED_BASE_URL);
  try {
    const response = await fetch(new URL('/healthz', deployed), {
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) return deployed;
  } catch (error) {
    console.warn(`Deployed DES target unavailable; using verified fixture: ${error.message}`);
  }
  fixtureStarted = true;
  return new URL((await startFixture()).baseURL);
}

before(async () => {
  await mkdir('artifacts', { recursive: true });
  baseURL = await chooseBaseURL();
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
});

after(async () => {
  await browser?.close();
  if (fixtureStarted) await stopFixture();
});

function url(path) {
  return new URL(path, baseURL).toString();
}

async function withPage(fn) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    return await fn(page);
  } finally {
    await page.close();
  }
}

test('liveness and readiness publish explicit JSON contracts', async () => {
  const healthResponse = await fetch(url('/healthz'));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.deepEqual(
    {
      ok: health.ok,
      service: health.service,
      publicBasePath: health.publicBasePath,
    },
    { ok: true, service: 'des-web', publicBasePath: '/des' },
  );
  assert.equal(typeof health.db, 'boolean');

  const readyResponse = await fetch(url('/readyz'));
  assert.ok([200, 503].includes(readyResponse.status));
  const readiness = await readyResponse.json();
  assert.equal(typeof readiness.ready, 'boolean');
  assert.equal(readyResponse.status, readiness.ready ? 200 : 503);
});

test('shared-layout pages render in Chromium', async (t) => {
  const pages = [
    ['/', /Discrete-event sims & games/i],
    ['/models', /Models/i],
    ['/games/soccer', /Soccer/i],
    ['/games/elevator', /Elevator/i],
  ];
  for (const [path, headingPattern] of pages) {
    await t.test(path, async () => {
      await withPage(async (page) => {
        const response = await page.goto(url(path), { waitUntil: 'domcontentloaded' });
        assert.equal(response?.status(), 200);
        const brand = await page.$eval('header .brand', (element) => element.textContent?.trim());
        assert.match(brand ?? '', /des-web/);
        const headings = await page.$$eval('h1, h2', (elements) => elements.map((element) => element.textContent?.trim() ?? ''));
        assert.ok(headings.some((heading) => headingPattern.test(heading)), `missing heading ${headingPattern} on ${path}: ${headings.join(' | ')}`);
      });
    });
  }
});

test('routing tool renders its self-contained solver dashboard', async () => {
  await withPage(async (page) => {
    const response = await page.goto(url('/tools/routing'), { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200);
    assert.match(await page.title(), /Optimal routing/i);
    const heading = await page.$eval('h1', (element) => element.textContent?.trim());
    assert.match(heading ?? '', /optimal routing/i);
    assert.ok(await page.$('#form'));
    assert.equal(await page.$eval('#status', (element) => element.textContent?.trim()), 'idle');
    assert.ok(await page.$('#canvas'));
  });
});

test('mounted HTML rewrites navigation to /des', async () => {
  await withPage(async (page) => {
    await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    const hrefs = await page.$$eval('header nav a', (links) => links.map((link) => link.getAttribute('href')));
    assert.ok(hrefs.length > 4);
    assert.ok(hrefs.every((href) => typeof href === 'string' && (href === '/des' || href.startsWith('/des/'))));
    await page.screenshot({ path: 'artifacts/des-home.png', fullPage: true });
  });
});

test('service-local partial and catalog API work in degraded mode', async () => {
  const partialResponse = await fetch(url('/partials/sims'));
  assert.equal(partialResponse.status, 200);
  const partial = await partialResponse.text();
  assert.match(partial, /Soccer rotation planner/);
  assert.match(partial, /\/des\/games\/soccer\/planner/);

  const catalogResponse = await fetch(url('/api/v1/catalog'));
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.deepEqual(
    {
      schema: catalog.schema,
      basePath: catalog.basePath,
      routing: catalog.pages?.routing,
      catalogApi: catalog.api?.catalog,
      application: catalog.ownership?.application,
    },
    {
      schema: 'des.route-catalog.v1',
      basePath: '/des',
      routing: '/des/tools/routing',
      catalogApi: '/des/api/v1/catalog',
      application: 'discrete-event-systems/des-web.rs',
    },
  );
});

test('browser response includes hardening headers', async () => {
  await withPage(async (page) => {
    const response = await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
    const headers = response?.headers() ?? {};
    assert.match(headers['content-security-policy'] ?? '', /default-src 'self'/);
    assert.match(headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  });
});

test('unknown paths return the application 404', async () => {
  await withPage(async (page) => {
    const response = await page.goto(url('/not-a-real-des-route'), { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 404);
    const body = await page.$eval('body', (element) => element.textContent);
    assert.match(body ?? '', /404/);
  });
});
