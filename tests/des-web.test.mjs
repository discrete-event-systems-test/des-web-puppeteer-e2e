import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { after, before } from "node:test";
import puppeteer from "puppeteer";

const baseURL = new URL(
  process.env.DES_BASE_URL ??
    "http://dd-des-web.default.svc.cluster.local:8130",
);

let browser;

before(async () => {
  await mkdir("artifacts", { recursive: true });
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
});

after(async () => {
  await browser?.close();
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

test("liveness and readiness publish explicit JSON contracts", async () => {
  const healthResponse = await fetch(url("/healthz"));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.deepEqual(
    {
      ok: health.ok,
      service: health.service,
      publicBasePath: health.publicBasePath,
    },
    { ok: true, service: "des-web", publicBasePath: "/des" },
  );
  assert.equal(typeof health.db, "boolean");

  const readyResponse = await fetch(url("/readyz"));
  assert.ok([200, 503].includes(readyResponse.status));
  const readiness = await readyResponse.json();
  assert.equal(typeof readiness.ready, "boolean");
  assert.equal(readyResponse.status, readiness.ready ? 200 : 503);
});

test("server-owned pages render in Chromium", async (t) => {
  const pages = [
    ["/", /Discrete-event sims & games/i],
    ["/models", /Models/i],
    ["/games/soccer", /Soccer/i],
    ["/games/elevator", /Elevator/i],
    ["/tools/routing", /Routing/i],
  ];

  for (const [path, headingPattern] of pages) {
    await t.test(path, async () => {
      await withPage(async (page) => {
        const response = await page.goto(url(path), {
          waitUntil: "domcontentloaded",
        });
        assert.equal(response?.status(), 200);
        const brand = await page.$eval("header .brand", (element) =>
          element.textContent?.trim(),
        );
        assert.match(brand ?? "", /des-web/);
        const headings = await page.$$eval("h1, h2", (elements) =>
          elements.map((element) => element.textContent?.trim() ?? ""),
        );
        assert.ok(
          headings.some((heading) => headingPattern.test(heading)),
          `missing heading ${headingPattern} on ${path}: ${headings.join(" | ")}`,
        );
      });
    });
  }
});

test("mounted HTML rewrites navigation to /des", async () => {
  await withPage(async (page) => {
    await page.goto(url("/"), { waitUntil: "domcontentloaded" });
    const hrefs = await page.$$eval("header nav a", (links) =>
      links.map((link) => link.getAttribute("href")),
    );
    assert.ok(hrefs.length > 4);
    assert.ok(hrefs.every((href) => href?.startsWith("/des/")));
    await page.screenshot({
      path: "artifacts/des-home.png",
      fullPage: true,
    });
  });
});

test("service-local partial and catalog API work in degraded mode", async () => {
  const partialResponse = await fetch(url("/partials/sims"));
  assert.equal(partialResponse.status, 200);
  const partial = await partialResponse.text();
  assert.match(partial, /Soccer rotation planner/);
  assert.match(partial, /\/des\/games\/soccer\/planner/);

  const catalogResponse = await fetch(url("/api/v1/catalog"));
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length >= 5);
});

test("browser response includes hardening headers", async () => {
  await withPage(async (page) => {
    const response = await page.goto(url("/"), {
      waitUntil: "domcontentloaded",
    });
    const headers = response?.headers() ?? {};
    assert.match(headers["content-security-policy"] ?? "", /default-src 'self'/);
    assert.match(headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(
      headers["referrer-policy"],
      "strict-origin-when-cross-origin",
    );
  });
});

test("unknown paths return the application 404", async () => {
  await withPage(async (page) => {
    const response = await page.goto(url("/not-a-real-des-route"), {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), 404);
    const body = await page.locator("body").textContent();
    assert.match(body ?? "", /404/);
  });
});
