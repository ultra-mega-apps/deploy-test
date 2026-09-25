# deploy-test — Hello World app + OIDC deploy consumer

This repo simulates an ordinary application. It is a Node.js app that
answers `Hello World` and knows nothing about OIDC, JWT or JWKS internals.

## Run

```sh
npm start
```

Listens on `0.0.0.0`, port `process.env.PORT || 3000`.
`GET /` responds `200 text/plain` with body `Hello World`.

## Local test

```sh
npm test
```

Starts the app, checks `curl http://127.0.0.1:3000/` returns HTTP 200
with `Hello World`, then stops it.

## Deploy

- Push to `main` requests a deploy to **STAGING**.
- Push a tag (`refs/tags/*`) requests a deploy to **PRODUCTION**.
- The workflow (`.github/workflows/deploy.yml`, `id-token: write`) downloads
  the deploy client from its authoritative source on every run:

  `https://raw.githubusercontent.com/ultra-mega-apps/public-bin/main/github-actions-deploy-me.sh`

- Authentication uses GitHub Actions OIDC: the client sends its OIDC token
  to the deploy-server, which answers `ALLOW`/`DENY`. No shared passwords,
  no deploy secrets in this repo.

Server implementation, auth library and OIDC tests live in
`ultra-mega-apps/deploy-server`. This repo is only a consumer.
