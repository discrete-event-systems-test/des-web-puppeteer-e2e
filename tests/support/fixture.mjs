import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const FIXTURE_SOURCE_SHA = '77741ec8b5331617f71416748ef5f06846e43a5d';
export const FIXTURE_IMAGE_DIGEST = 'sha256:c3b32a5ef767bcdba515c8199fce363871ba2916e4c824609a09a37b3adc02e5';
export const FIXTURE_ARCHIVE_SHA256 = '1d8fe97fc285055558fd2e723789a82118d998a595b57a6e8581562bfd18befa';
export const FIXTURE_URL = 'https://github.com/discrete-event-systems/des-web.rs/releases/download/des-browser-fixture-77741ec8/des-web-x86_64-unknown-linux-gnu.tar.gz';
const FIXTURE_PROVENANCE_URL = 'https://github.com/discrete-event-systems/des-web.rs/releases/download/des-browser-fixture-77741ec8/fixture-provenance.json';

const root = path.resolve('test-results/fixture');
const archivePath = path.join(root, 'des-web.tar.gz');
const binaryPath = path.join(root, 'des-web');
const pidPath = path.join(root, 'des-web.pid');
const logPath = path.join(root, 'des-web.log');
const provenancePath = path.join(root, 'fixture-provenance.json');

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) {
    throw new Error(`fixture download failed: ${url} returned HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

async function waitForHealth(baseURL, child) {
  let lastError = 'not started';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`fixture exited before health check with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`fixture did not become healthy: ${lastError}`);
}

export async function startFixture() {
  await fs.mkdir(root, { recursive: true });
  let archiveValid = false;
  try {
    archiveValid = (await sha256(archivePath)) === FIXTURE_ARCHIVE_SHA256;
  } catch {
    archiveValid = false;
  }
  if (!archiveValid) await download(FIXTURE_URL, archivePath);
  const observed = await sha256(archivePath);
  if (observed !== FIXTURE_ARCHIVE_SHA256) {
    throw new Error(`fixture checksum mismatch: ${observed} != ${FIXTURE_ARCHIVE_SHA256}`);
  }

  await fs.rm(binaryPath, { force: true });
  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', root], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`fixture extraction failed: ${extracted.stderr || extracted.stdout}`);
  await fs.chmod(binaryPath, 0o700);

  const provenanceResponse = await fetch(FIXTURE_PROVENANCE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!provenanceResponse.ok) throw new Error(`fixture provenance returned HTTP ${provenanceResponse.status}`);
  const provenance = await provenanceResponse.json();
  if (provenance.sourceSha !== FIXTURE_SOURCE_SHA || provenance.sourceImageDigest !== FIXTURE_IMAGE_DIGEST || provenance.archiveSha256 !== FIXTURE_ARCHIVE_SHA256) {
    throw new Error('fixture provenance does not match the pinned production revision');
  }
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });

  const port = Number.parseInt(process.env.DES_FIXTURE_PORT ?? '18131', 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DES_FIXTURE_PORT must be an unprivileged TCP port');
  }
  const baseURL = `http://127.0.0.1:${port}`;
  const logHandle = await fs.open(logPath, 'a', 0o600);
  const child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      HOME: root,
      HOST: '127.0.0.1',
      PORT: String(port),
      DES_PUBLIC_PATH_MODE: 'mounted',
      DES_UPSTREAM_URL: 'http://127.0.0.1:9',
    },
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  await fs.writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  await waitForHealth(baseURL, child);
  await logHandle.close();
  return {
    baseURL,
    mode: 'fixture',
    probePath: '/healthz',
    probeStatus: 200,
    sourceSha: FIXTURE_SOURCE_SHA,
    sourceImageDigest: FIXTURE_IMAGE_DIGEST,
    archiveSha256: FIXTURE_ARCHIVE_SHA256,
  };
}

export async function stopFixture() {
  let pid;
  try {
    pid = Number.parseInt((await fs.readFile(pidPath, 'utf8')).trim(), 10);
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await fs.rm(pidPath, { force: true });
}
