/**
 * End-to-end tests: the REAL github-actions-deploy-me.sh Bash script runs
 * as a subprocess against a fake GitHub Actions environment, a fake OIDC
 * issuer (real RS256 JWTs), and the REAL demo server + auth library.
 *
 * Nothing on the golden path is mocked: Bash -> fake OIDC endpoint ->
 * signed JWT -> local HTTP POST -> server -> auth lib -> fake JWKS.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import { startFakeOidc, mintJwt, TEST_AUDIENCE, FAKE_SHA } from './fake-oidc.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH =
  process.env.SCRIPT_PATH ||
  path.resolve(TEST_DIR, '..', '..', 'public-bin', 'github-actions-deploy-me.sh');

const REPO = 'ultra-mega-apps/deploy-test';
const OWNER = 'ultra-mega-apps';
const MAIN_REF = 'refs/heads/main';
const FAKE_RUNNER_TOKEN = 'fake-runner-token-for-tests';

let oidc = null;
let deploy = null;
let savedEnv = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

/** Start fake OIDC + real deploy server + fake GitHub Actions env. */
async function setup({ oidcOverrides = {}, ref = MAIN_REF, deployVar = null } = {}) {
  oidc = await startFakeOidc({ overrides: oidcOverrides });
  const logFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-e2e-')),
    'deploy.log',
  );
  const port = await freePort();
  const server = await startServer({
    port,
    host: '127.0.0.1',
    logFile,
    issuer: oidc.url,
    audience: TEST_AUDIENCE,
    allowedOwner: OWNER,
  });
  deploy = { server, port, logFile };

  savedEnv = {};
  for (const k of [
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_OWNER',
    'GITHUB_REF',
    'GITHUB_SHA',
    'FIXED_JWT',
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.GITHUB_REPOSITORY = REPO;
  process.env.GITHUB_REPOSITORY_OWNER = OWNER;
  process.env.GITHUB_REF = ref;
  process.env.GITHUB_SHA = FAKE_SHA;
  delete process.env.FIXED_JWT;

  const env = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_OWNER: OWNER,
    GITHUB_REF: ref,
    GITHUB_SHA: FAKE_SHA,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${oidc.url}/oidc`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: FAKE_RUNNER_TOKEN,
    DEPLOY:
      deployVar ??
      `STAGING|http://127.0.0.1:${port}|PRODUCTION|http://127.0.0.1:${port}`,
  };
  return env;
}

afterEach(async () => {
  await closeServer(oidc?.server);
  await closeServer(deploy?.server);
  oidc = null;
  deploy = null;
  if (savedEnv) {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv = null;
  }
});

function runScript(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT_PATH, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function readLog() {
  return fs.existsSync(deploy.logFile) ? fs.readFileSync(deploy.logFile, 'utf8') : '';
}

async function fetchOidcToken(query = '') {
  const res = await fetch(`${oidc.url}/oidc${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).value;
}

function postDeploy({ token, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: deploy.port,
        path: '/deploy',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const goodBody = (over = {}) => ({
  repository: REPO,
  repositoryOwner: OWNER,
  ref: MAIN_REF,
  sha: FAKE_SHA,
  environment: 'STAGING',
  ...over,
});

before(async () => {
  assert.ok(
    fs.existsSync(SCRIPT_PATH),
    `deploy script not found at ${SCRIPT_PATH} (set SCRIPT_PATH to override)`,
  );
});

describe('end-to-end: github-actions-deploy-me.sh', () => {
  it('valid main push -> ALLOW STAGING (no manual repository/environment args)', async () => {
    const env = await setup();
    const res = await runScript(env); // no extra args, no manual env
    assert.equal(res.code, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /environment=STAGING/);
    assert.match(readLog(), /ALLOW repository=ultra-mega-apps\/deploy-test environment=STAGING ref=refs\/heads\/main/);
  });

  it('valid tag push -> ALLOW PRODUCTION', async () => {
    const env = await setup({ ref: 'refs/tags/v1.0.0' });
    const res = await runScript(env);
    assert.equal(res.code, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(readLog(), /ALLOW repository=ultra-mega-apps\/deploy-test environment=PRODUCTION ref=refs\/tags\/v1\.0\.0/);
  });

  it('branch other than main -> clear failure, no deploy', async () => {
    const env = await setup({ ref: 'refs/heads/feature-x' });
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not deployable/);
    assert.equal(readLog(), '');
  });

  it('repository_owner outside ultra-mega-apps -> DENY', async () => {
    const env = await setup();
    env.GITHUB_REPOSITORY = 'evil-org/deploy-test';
    env.GITHUB_REPOSITORY_OWNER = 'evil-org';
    process.env.GITHUB_REPOSITORY = 'evil-org/deploy-test';
    process.env.GITHUB_REPOSITORY_OWNER = 'evil-org';
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="unauthorized repository_owner"/);
  });

  it('body repository != JWT repository -> DENY', async () => {
    // Fake issuer mints for another repo; the script honestly reports its own.
    const env = await setup({ oidcOverrides: { repository: 'ultra-mega-apps/other' } });
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="repository mismatch"/);
  });

  it('body ref != JWT ref -> DENY', async () => {
    const env = await setup({ oidcOverrides: { ref: 'refs/tags/v9.9.9' } });
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="ref mismatch"/);
  });

  it('tampered environment in body -> DENY (direct POST, valid JWT)', async () => {
    await setup();
    const token = await fetchOidcToken();
    const res = await postDeploy({ token, body: goodBody({ environment: 'PRODUCTION' }) });
    assert.equal(res.status, 403);
    assert.match(readLog(), /DENY reason="environment mismatch"/);
  });

  it('tampered repository in body -> DENY (direct POST, valid JWT)', async () => {
    await setup();
    const token = await fetchOidcToken();
    const res = await postDeploy({ token, body: goodBody({ repository: 'ultra-mega-apps/evil' }) });
    assert.equal(res.status, 403);
    assert.match(readLog(), /DENY reason="repository mismatch"/);
  });

  it('missing token -> HTTP 401 + DENY', async () => {
    await setup();
    const res = await postDeploy({ token: null, body: goodBody() });
    assert.equal(res.status, 401);
    assert.match(readLog(), /DENY reason="missing token"/);
  });

  it('expired token -> script fails, DENY', async () => {
    const env = await setup();
    env.ACTIONS_ID_TOKEN_REQUEST_URL = `${oidc.url}/oidc?scenario=expired`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="token expired"/);
  });

  it('wrong issuer -> script fails, DENY', async () => {
    const env = await setup();
    env.ACTIONS_ID_TOKEN_REQUEST_URL = `${oidc.url}/oidc?scenario=bad-issuer`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="invalid issuer"/);
  });

  it('wrong audience -> script fails, DENY', async () => {
    const env = await setup();
    env.ACTIONS_ID_TOKEN_REQUEST_URL = `${oidc.url}/oidc?scenario=bad-audience`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="invalid audience"/);
  });

  it('invalid signature -> script fails, DENY', async () => {
    const env = await setup();
    env.ACTIONS_ID_TOKEN_REQUEST_URL = `${oidc.url}/oidc?scenario=bad-signature`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(readLog(), /DENY reason="invalid signature"/);
  });

  it('malformed DEPLOY -> clear errors', async () => {
    for (const [deployVar, expected] of [
      ['', 'missing: DEPLOY'],
      ['   ', 'DEPLOY is empty'],
      ['STAGING|http://127.0.0.1:1|PRODUCTION', 'odd number'],
      ['STAGING|http://127.0.0.1:1|STAGING|http://127.0.0.1:2', "duplicated environment 'STAGING'"],
    ]) {
      const env = await setup({ deployVar });
      const res = await runScript(env);
      assert.notEqual(res.code, 0, deployVar);
      assert.match(res.stderr, new RegExp(expected), deployVar);
      await closeServer(oidc?.server);
      await closeServer(deploy?.server);
      oidc = null;
      deploy = null;
    }
  });

  it('STAGING missing from DEPLOY -> clear error', async () => {
    const env = await setup();
    env.DEPLOY = `PRODUCTION|http://127.0.0.1:${deploy.port}`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /No endpoint configured for environment STAGING/);
  });

  it('PRODUCTION missing from DEPLOY -> clear error', async () => {
    const env = await setup({ ref: 'refs/tags/v1.0.0' });
    env.DEPLOY = `STAGING|http://127.0.0.1:${deploy.port}`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /No endpoint configured for environment PRODUCTION/);
  });

  it('spaces in DEPLOY are tolerated', async () => {
    const env = await setup();
    env.DEPLOY = ` STAGING | http://127.0.0.1:${deploy.port} | PRODUCTION | http://127.0.0.1:${deploy.port} `;
    const res = await runScript(env);
    assert.equal(res.code, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(readLog(), /ALLOW .* environment=STAGING/);
  });

  it('endpoint returning HTTP 500 -> CLI exits non-zero', async () => {
    const env = await setup();
    const stub = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      env.DEPLOY = `STAGING|http://127.0.0.1:${stub.address().port}|PRODUCTION|http://127.0.0.1:${stub.address().port}`;
      const res = await runScript(env);
      assert.notEqual(res.code, 0);
      assert.match(res.stderr, /deploy request .* failed|HTTP 500/);
    } finally {
      await closeServer(stub);
    }
  });

  it('unreachable endpoint -> CLI exits non-zero', async () => {
    const env = await setup();
    const closed = await freePort();
    env.DEPLOY = `STAGING|http://127.0.0.1:${closed}|PRODUCTION|http://127.0.0.1:${closed}`;
    const res = await runScript(env);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /deploy request .* failed/);
  });

  it('JWT never appears in stdout, stderr or the log file', async () => {
    const env = await setup();
    const token = await mintJwt({ privateKey: oidc.privateKey, issuer: oidc.url });
    process.env.FIXED_JWT = token;
    const res = await runScript(env);
    assert.equal(res.code, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const log = readLog();
    for (const [name, content] of [
      ['stdout', res.stdout],
      ['stderr', res.stderr],
      ['log file', log],
    ]) {
      assert.ok(!content.includes(token), `JWT leaked in ${name}`);
      assert.ok(!content.includes('eyJ'), `JWT-looking string in ${name}`);
    }
    assert.ok(!res.stdout.includes(FAKE_RUNNER_TOKEN), 'runner token in stdout');
    assert.ok(!log.includes(FAKE_RUNNER_TOKEN), 'runner token in log');
    assert.match(log, /ALLOW /);
  });

  it('extra CLI params are sent as untrusted metadata without breaking auth', async () => {
    const env = await setup();
    const res = await runScript(env, ['--note', 'hello world']);
    assert.equal(res.code, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(readLog(), /ALLOW .* environment=STAGING/);
  });
});
