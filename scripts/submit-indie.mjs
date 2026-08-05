import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const baseURL = String(process.env.GHA_INDIE_WORKER_URL ?? '').trim().replace(/\/+$/, '');
const auth = String(process.env.GHA_INDIE_WORKER_AUTH ?? process.env.DES_GATEWAY_AUTH ?? '').trim();
const repository = String(process.env.GITHUB_REPOSITORY ?? 'discrete-event-systems-test/des-web-puppeteer-e2e').trim();
const revision = String(process.env.GITHUB_SHA ?? process.env.GHA_INDIE_REVISION ?? '').trim();
const workflowPath = '.gha/workflows/puppeteer.yml';

if (!baseURL) throw new Error('GHA_INDIE_WORKER_URL is required');
if (!auth) throw new Error('GHA_INDIE_WORKER_AUTH or DES_GATEWAY_AUTH is required');
if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('GITHUB_SHA/GHA_INDIE_REVISION must be an exact 40-hex commit');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/name');

const workflowYaml = await fs.readFile(workflowPath, 'utf8');
const requestId = `des-puppeteer:${revision}:${crypto.createHash('sha256').update(workflowYaml).digest('hex').slice(0, 16)}`;
const payload = { schemaVersion: 'gha-indie-workflow.v1', repository, revision, workflowPath, workflowYaml, requestId };
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  auth,
  cookie: `dd_auth=${auth}`,
};

async function post(path) {
  const response = await fetch(`${baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

const plan = await post('/gha/workflows/plan');
console.log(JSON.stringify({ stage: 'plan', plan }, null, 2));
const run = await post('/gha/workflows/runs');
console.log(JSON.stringify({ stage: 'run', run }, null, 2));
