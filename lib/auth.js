/**
 * OIDC deploy authorization library.
 *
 * This is the serious, reusable part of the demo. It validates a GitHub
 * Actions OIDC JWT for real (cryptographic signature via JWKS, issuer,
 * audience, expiration) and cross-checks every untrusted field of the
 * POST body against the authenticated token claims.
 *
 * The returned result is the trustworthy source for any future deploy
 * code. Callers must NOT use raw body fields to decide anything.
 *
 * Decided environment mapping (derived from the AUTHENTICATED ref only):
 *   refs/heads/main -> STAGING
 *   refs/tags/*     -> PRODUCTION
 *
 * SHA: GitHub's OIDC discovery document advertises the `sha` claim, so a
 * present claim is compared against the body. If the claim is missing the
 * request is denied (fail closed) instead of silently treating the body
 * SHA as authenticated.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

export const PRODUCTION_ISSUER = 'https://token.actions.githubusercontent.com';
export const DEFAULT_AUDIENCE = 'https://deploy.umapps.net';
export const DEFAULT_ALLOWED_OWNER = 'ultra-mega-apps';

/**
 * Derive the trusted environment from an authenticated git ref.
 * Returns 'STAGING', 'PRODUCTION', or null when the ref is not deployable.
 */
export function environmentFromRef(ref) {
  if (ref === 'refs/heads/main') return 'STAGING';
  if (typeof ref === 'string' && ref.startsWith('refs/tags/') && ref.length > 'refs/tags/'.length) {
    return 'PRODUCTION';
  }
  return null;
}

const jwksCache = new Map();

function getJWKS(jwksUri) {
  if (!jwksCache.has(jwksUri)) {
    jwksCache.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksCache.get(jwksUri);
}

async function resolveJwksUri(issuer) {
  const url = issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw Object.assign(new Error(`OIDC discovery failed for ${issuer}: ${err.message}`), { code: 'OIDC_DISCOVERY_FAILED' });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`), { code: 'OIDC_DISCOVERY_FAILED' });
  }
  const doc = await res.json();
  if (!doc || typeof doc.jwks_uri !== 'string' || !doc.jwks_uri) {
    throw Object.assign(new Error(`OIDC discovery document for ${issuer} has no jwks_uri`), { code: 'OIDC_DISCOVERY_FAILED' });
  }
  return doc.jwks_uri;
}

function deny(reason) {
  return { authorized: false, reason };
}

function mapJwtError(err) {
  const code = err && err.code;
  if (code === 'OIDC_DISCOVERY_FAILED') return 'issuer unreachable';
  if (code === 'ERR_JWT_EXPIRED') return 'token expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const msg = String((err && err.message) || '');
    if (msg.includes('"iss"')) return 'invalid issuer';
    if (msg.includes('"aud"')) return 'invalid audience';
    if (msg.includes('"nbf"') || msg.includes('not active')) return 'token not active';
    return 'invalid claim';
  }
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    code === 'ERR_JWKS_EMPTY' ||
    code === 'ERR_JWS_INVALID' ||
    code === 'ERR_JWT_INVALID'
  ) {
    return 'invalid signature';
  }
  if (code === 'ERR_JWT_MALFORMED') return 'malformed token';
  return 'invalid token';
}

/**
 * Authorize a deployment request.
 *
 * @param {object} args
 * @param {string} args.token - OIDC JWT from the Authorization header.
 * @param {object} args.body - Parsed JSON POST body (UNTRUSTED until checked).
 * @param {string} [args.issuer] - Expected `iss` (default: GitHub production).
 * @param {string} [args.audience] - Expected `aud` (default: project audience).
 * @param {string} [args.allowedOwner] - Allowed `repository_owner` org.
 *
 * @returns {Promise<object>} `{ authorized: true, repository, repositoryOwner,
 *   ref, sha, environment }` or `{ authorized: false, reason }`.
 */
export async function authorizeDeployment({
  token,
  body,
  issuer = PRODUCTION_ISSUER,
  audience = DEFAULT_AUDIENCE,
  allowedOwner = DEFAULT_ALLOWED_OWNER,
}) {
  if (typeof token !== 'string' || token.length === 0) {
    return deny('missing token');
  }
  // Structural check first: a JWT must be three base64url segments.
  // Anything else is malformed input, not a cryptographic failure.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return deny('malformed token');
  }

  let claims;
  try {
    const jwksUri = await resolveJwksUri(issuer);
    const verified = await jwtVerify(token, getJWKS(jwksUri), { issuer, audience });
    claims = verified.payload;
  } catch (err) {
    return deny(mapJwtError(err));
  }

  const { repository, repository_owner: repositoryOwner, ref, sha } = claims;

  if (typeof repository !== 'string' || !repository.includes('/')) {
    return deny('invalid repository claim');
  }
  if (repositoryOwner !== allowedOwner) {
    return deny('unauthorized repository_owner');
  }
  const environment = environmentFromRef(ref);
  if (!environment) {
    return deny('unrecognized ref');
  }
  // GitHub advertises the `sha` claim in its discovery document; require it
  // and compare instead of trusting the body SHA.
  if (typeof sha !== 'string' || sha.length === 0) {
    return deny('missing sha claim');
  }

  // Cross-check every body field against the authenticated claims.
  // The body environment is convenience only; the trusted value above wins.
  const b = body && typeof body === 'object' ? body : {};
  if (b.repository !== repository) return deny('repository mismatch');
  if (b.repositoryOwner !== repositoryOwner) return deny('repository_owner mismatch');
  if (b.ref !== ref) return deny('ref mismatch');
  if (b.sha !== sha) return deny('sha mismatch');
  if (b.environment !== environment) return deny('environment mismatch');

  return { authorized: true, repository, repositoryOwner, ref, sha, environment };
}
