import http from 'node:http';
import https from 'node:https';

const CURRENT_PUBLIC_GATEWAY = 'https://54.91.17.58';
const PREVIOUS_PUBLIC_GATEWAY = 'https://98.90.186.114';
const INTERNAL_CANDIDATES = [
  'http://dd-des-web.default.svc.cluster.local:8130',
  'http://dd-des-simulator.default.svc.cluster.local:8099',
];
const BOUNDARY_STATUSES = new Set([301, 302, 303, 307, 308, 401, 403]);
const SERVICE_LOCAL_MODES = new Set(['internal', 'fixture']);

function clean(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function usesServiceLocalPaths(mode) {
  return SERVICE_LOCAL_MODES.has(mode);
}

export function pathForTarget(publicPath, mode) {
  if (!usesServiceLocalPaths(mode)) return publicPath;
  if (publicPath === '/des' || publicPath === '/des/') return '/';
  if (publicPath.startsWith('/des/')) return publicPath.slice('/des'.length);
  return publicPath;
}

function isInternal(baseURL) {
  return baseURL.includes('.svc.cluster.local') || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|$)/.test(baseURL);
}

function requestOnce(url, { headers = {}, timeout = 6_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, {
      method: 'GET',
      headers,
      rejectUnauthorized: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error(`timeout after ${timeout}ms`)));
    request.on('error', reject);
    request.end();
  });
}

function authHeaders(baseURL) {
  const value = String(process.env.DES_GATEWAY_AUTH ?? '').trim();
  if (!value || isInternal(baseURL)) return {};
  return { auth: value, cookie: `dd_auth=${value}`, accept: 'text/html' };
}

export async function resolveTarget() {
  const candidates = [...new Set([
    clean(process.env.DES_BASE_URL),
    ...INTERNAL_CANDIDATES,
    clean(process.env.DES_PUBLIC_BASE_URL),
    CURRENT_PUBLIC_GATEWAY,
    PREVIOUS_PUBLIC_GATEWAY,
  ].filter(Boolean))];
  const failures = [];
  for (const baseURL of candidates) {
    const paths = isInternal(baseURL) ? ['/healthz', '/api/v1/catalog', '/'] : ['/des/'];
    for (const path of paths) {
      try {
        const response = await requestOnce(`${baseURL}${path}`, { headers: authHeaders(baseURL) });
        if (isInternal(baseURL) && response.status >= 200 && response.status < 500) {
          return { baseURL, mode: 'internal', probePath: path, probeStatus: response.status };
        }
        if (!isInternal(baseURL) && response.status >= 200 && response.status < 300) {
          return {
            baseURL,
            mode: process.env.DES_GATEWAY_AUTH ? 'public-authenticated' : 'public-open',
            probePath: path,
            probeStatus: response.status,
          };
        }
        if (!isInternal(baseURL) && BOUNDARY_STATUSES.has(response.status)) {
          return { baseURL, mode: 'public-auth-boundary', probePath: path, probeStatus: response.status };
        }
        failures.push(`${baseURL}${path}: HTTP ${response.status}`);
      } catch (error) {
        failures.push(`${baseURL}${path}: ${error.message}`);
      }
    }
  }
  throw new Error(`No DES target was reachable. ${failures.join(' | ')}`);
}

export async function fetchTarget(baseURL, path, { mountPrefix = false } = {}) {
  const headers = authHeaders(baseURL);
  if (mountPrefix) headers['x-forwarded-prefix'] = '/des';
  return requestOnce(`${clean(baseURL)}${path}`, { headers });
}

export function gatewayCookie(baseURL, mode) {
  const value = String(process.env.DES_GATEWAY_AUTH ?? '').trim();
  if (!value || mode !== 'public-authenticated') return null;
  return { name: 'dd_auth', value, url: baseURL, httpOnly: true, secure: baseURL.startsWith('https:') };
}
