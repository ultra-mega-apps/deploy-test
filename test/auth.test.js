/**
 * Unit tests for lib/auth.js against the fake OIDC issuer.
 *
 * Tokens are REAL RS256 JWTs minted with a test key; the library verifies
 * them against the fake JWKS served over HTTP (issuer injected per test).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDeployment, environmentFromRef } from '../lib/auth.js';
import { startFakeOidc, mintJwt, TEST_AUDIENCE, FAKE_SHA, REAL_GITHUB_ISSUER } from './fake-oidc.js';

let oidc;

before(async () => {
  oidc = await startFakeOidc();
});

after(async () => {
  await oidc.close();
});

const goodBody = (over = {}) => ({
  repository: 'ultra-mega-apps/deploy-test',
  repositoryOwner: 'ultra-mega-apps',
  ref: 'refs/heads/main',
  sha: FAKE_SHA,
  environment: 'STAGING',
  ...over,
});

const goodToken = (claims = {}, opts = {}) =>
  mintJwt({ privateKey: oidc.privateKey, issuer: oidc.url, claims, ...opts });

const check = (token, body, extra = {}) =>
  authorizeDeployment({
    token,
    body,
    issuer: oidc.url,
    audience: TEST_AUDIENCE,
    allowedOwner: 'ultra-mega-apps',
    ...extra,
  });

describe('environmentFromRef', () => {
  it('maps refs/heads/main to STAGING', () => {
    assert.equal(environmentFromRef('refs/heads/main'), 'STAGING');
  });
  it('maps refs/tags/* to PRODUCTION', () => {
    assert.equal(environmentFromRef('refs/tags/v1.0.0'), 'PRODUCTION');
    assert.equal(environmentFromRef('refs/tags/release/2026.09'), 'PRODUCTION');
  });
  it('returns null for anything else', () => {
    assert.equal(environmentFromRef('refs/heads/feature-x'), null);
    assert.equal(environmentFromRef('refs/pull/1/merge'), null);
    assert.equal(environmentFromRef('refs/tags/'), null);
    assert.equal(environmentFromRef(''), null);
    assert.equal(environmentFromRef(undefined), null);
  });
});

describe('authorizeDeployment', () => {
  it('valid main token -> ALLOW with environment STAGING', async () => {
    const res = await check(await goodToken(), goodBody());
    assert.equal(res.authorized, true);
    assert.equal(res.environment, 'STAGING');
    assert.equal(res.repository, 'ultra-mega-apps/deploy-test');
    assert.equal(res.repositoryOwner, 'ultra-mega-apps');
    assert.equal(res.ref, 'refs/heads/main');
    assert.equal(res.sha, FAKE_SHA);
  });

  it('valid tag token -> ALLOW with environment PRODUCTION', async () => {
    const token = await goodToken({ ref: 'refs/tags/v2.0.0' });
    const res = await check(
      token,
      goodBody({ ref: 'refs/tags/v2.0.0', environment: 'PRODUCTION' }),
    );
    assert.equal(res.authorized, true);
    assert.equal(res.environment, 'PRODUCTION');
  });

  it('valid signature but unknown ref -> DENY', async () => {
    const token = await goodToken({ ref: 'refs/heads/feature-x' });
    const res = await check(token, goodBody({ ref: 'refs/heads/feature-x' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'unrecognized ref');
  });

  it('different repository_owner -> DENY', async () => {
    const token = await goodToken({ repository: 'evil-org/deploy-test', repository_owner: 'evil-org' });
    const res = await check(
      token,
      goodBody({ repository: 'evil-org/deploy-test', repositoryOwner: 'evil-org' }),
    );
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'unauthorized repository_owner');
  });

  it('body repository != JWT -> DENY', async () => {
    const res = await check(await goodToken(), goodBody({ repository: 'ultra-mega-apps/other' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'repository mismatch');
  });

  it('body repositoryOwner != JWT -> DENY', async () => {
    const res = await check(await goodToken(), goodBody({ repositoryOwner: 'evil-org' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'repository_owner mismatch');
  });

  it('body ref != JWT -> DENY', async () => {
    const res = await check(await goodToken(), goodBody({ ref: 'refs/tags/v9.9.9' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'ref mismatch');
  });

  it('body environment != derived -> DENY (main never yields PRODUCTION)', async () => {
    const res = await check(await goodToken(), goodBody({ environment: 'PRODUCTION' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'environment mismatch');
  });

  it('tag body claiming STAGING -> DENY', async () => {
    const token = await goodToken({ ref: 'refs/tags/v1.0.0' });
    const res = await check(token, goodBody({ ref: 'refs/tags/v1.0.0', environment: 'STAGING' }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'environment mismatch');
  });

  it('body sha != JWT sha -> DENY', async () => {
    const res = await check(await goodToken(), goodBody({ sha: 'fff'.padEnd(40, 'f') }));
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'sha mismatch');
  });

  it('missing sha claim -> DENY (fail closed)', async () => {
    const token = await goodToken({ sha: undefined });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'missing sha claim');
  });

  it('expired token -> DENY', async () => {
    const token = await goodToken({}, { issuedAtOffsetSeconds: -600, expiresInSeconds: 300 });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'token expired');
  });

  it('not-yet-active token -> DENY', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await goodToken({ nbf: now + 600 }, { issuedAtOffsetSeconds: 600, expiresInSeconds: 900 });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'token not active');
  });

  it('wrong issuer -> DENY', async () => {
    const token = await mintJwt({ privateKey: oidc.privateKey, issuer: REAL_GITHUB_ISSUER });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'invalid issuer');
  });

  it('wrong audience -> DENY', async () => {
    const token = await mintJwt({ privateKey: oidc.privateKey, issuer: oidc.url, audience: 'https://other.example.com' });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'invalid audience');
  });

  it('invalid signature -> DENY', async () => {
    const token = await mintJwt({ privateKey: oidc.evilKey, issuer: oidc.url });
    const res = await check(token, goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'invalid signature');
  });

  it('missing token -> DENY', async () => {
    for (const token of [undefined, '', null]) {
      const res = await check(token, goodBody());
      assert.equal(res.authorized, false);
      assert.equal(res.reason, 'missing token');
    }
  });

  it('malformed token -> DENY', async () => {
    const res = await check('not-a-jwt', goodBody());
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'malformed token');
  });

  it('unreachable issuer -> DENY without hanging', async () => {
    const token = await goodToken();
    const res = await check(token, goodBody(), { issuer: 'http://127.0.0.1:9/nope' });
    assert.equal(res.authorized, false);
    assert.equal(res.reason, 'issuer unreachable');
  });
});
