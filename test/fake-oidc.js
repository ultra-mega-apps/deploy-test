/**
 * Fake GitHub Actions OIDC issuer for tests.
 *
 * Exposes a real OIDC discovery document + JWKS and mints REAL RS256 JWTs
 * with a test keypair. The auth library validates signatures against this
 * fake JWKS (injected via the `issuer` option); production defaults stay
 * pinned to https://token.actions.githubusercontent.com.
 *
 * There is deliberately NO skipVerification path anywhere.
 */

import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export const TEST_AUDIENCE = 'https://deploy.umapps.net';
export const FAKE_SHA = '0123456789abcdef0123456789abcdef01234567';
export const REAL_GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

export function baseClaimsFromEnv() {
  return {
    repository: process.env.GITHUB_REPOSITORY || 'ultra-mega-apps/deploy-test',
    repository_owner: process.env.GITHUB_REPOSITORY_OWNER || 'ultra-mega-apps',
    ref: process.env.GITHUB_REF || 'refs/heads/main',
    sha: process.env.GITHUB_SHA || FAKE_SHA,
  };
}

export async function mintJwt({
  privateKey,
  issuer,
  audience = TEST_AUDIENCE,
  claims = {},
  issuedAtOffsetSeconds = 0,
  expiresInSeconds = 300,
  keyId = 'test-key-1',
}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...baseClaimsFromEnv(), ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now + issuedAtOffsetSeconds)
    .setExpirationTime(now + issuedAtOffsetSeconds + expiresInSeconds)
    .sign(privateKey);
}

export async function startFakeOidc({ overrides = {} } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const { publicKey: evilPublicKey, privateKey: evilKey } = await generateKeyPair('RS256');
  void evilPublicKey;
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };

  let baseUrl = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(200, { issuer: baseUrl, jwks_uri: `${baseUrl}/jwks` });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      json(200, { keys: [publicJwk] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oidc') {
      // Test hook: return a pre-minted token so tests can assert it never
      // appears in logs. Read per-request so tests can toggle via env.
      if (process.env.FIXED_JWT) {
        json(200, { value: process.env.FIXED_JWT });
        return;
      }
      const scenario = url.searchParams.get('scenario') || 'normal';
      const claims = { ...baseClaimsFromEnv(), ...overrides };
      try {
        let token;
        if (scenario === 'expired') {
          token = await mintJwt({ privateKey, issuer: baseUrl, claims, issuedAtOffsetSeconds: -600, expiresInSeconds: 300 });
        } else if (scenario === 'bad-audience') {
          token = await mintJwt({ privateKey, issuer: baseUrl, audience: 'https://other.example.com', claims });
        } else if (scenario === 'bad-issuer') {
          token = await mintJwt({ privateKey, issuer: REAL_GITHUB_ISSUER, claims });
        } else if (scenario === 'bad-signature') {
          token = await mintJwt({ privateKey: evilKey, issuer: baseUrl, claims });
        } else {
          token = await mintJwt({ privateKey, issuer: baseUrl, claims });
        }
        json(200, { value: token });
      } catch (err) {
        json(500, { error: String(err.message || err) });
      }
      return;
    }
    json(404, { error: 'not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    url: baseUrl,
    server,
    privateKey,
    evilKey,
    publicJwk,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
