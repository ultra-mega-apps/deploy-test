# deploy-test — OIDC deploy authorization demo

Demo server + serious auth library proving GitHub Actions OIDC deploys.
The server authorizes; it never performs a real deploy.

## Install / test / run

```sh
npm install
npm test          # unit + end-to-end (runs the real .sh as a subprocess)
PORT=3000 LOG_FILE=./deploy.log npm start
```

`npm test` needs `bash`, `curl` and `python3` (for the `.sh` e2e path);
the parser-only suite in `public-bin` is dependency-free bash.

## How OIDC validation works (`lib/auth.js`, dependency: `jose`)

1. OIDC discovery at `<issuer>/.well-known/openid-configuration`, JWKS
   fetched from `jwks_uri` (`https://token.actions.githubusercontent.com`
   in production).
2. `jwtVerify` checks signature, `iss`, `aud`
   (`https://deploy.umapps.net`), `exp` and `nbf`.
3. Claims checked: `repository_owner === ultra-mega-apps`,
   environment re-derived from the authenticated `ref`
   (`refs/heads/main` → STAGING, `refs/tags/*` → PRODUCTION),
   `sha` claim required (GitHub advertises it) and compared.
4. Every body field (`repository`, `repositoryOwner`, `ref`, `sha`,
   `environment`) is compared against the token; any mismatch → DENY.
   Extra `params` are ignored metadata.

## DEPLOY organization variable

```
STAGING|https://deploy.storage.umapps.net
```

Future example with production:

```
STAGING|https://ofrg1.umapps.net:50000|PRODUCTION|https://oagp1.umapps.net:50000
```

Create it at org **Settings → Secrets and variables → Actions →
Variables**, name `DEPLOY`, repository access including this repo.

## Log

`LOG_FILE` (default `./deploy.log`):

```
2026-... ALLOW repository=ultra-mega-apps/deploy-test environment=STAGING ref=refs/heads/main sha=...
2026-... DENY reason="invalid audience"
```

Tokens are never logged or stored.

## Real endpoint of this PoC

CapRover app `deploy` → `https://deploy.storage.umapps.net`
(valid Let's Encrypt cert, port 443), proxying to this server's
`POST /deploy`. See `Dockerfile` + `captain-definition`.
