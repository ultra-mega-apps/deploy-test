/**
 * Demo deploy-receiver server.
 *
 * Intentionally thin: it receives POST /deploy, delegates every decision
 * to lib/auth.js, prints the structured result to the terminal, appends
 * it to a log file, and does NOT perform any real deploy.
 *
 * Security: the OIDC token is never printed and never written to disk.
 *
 * Configuration (environment variables):
 *   PORT            listen port (default 3000; tests use ephemeral ports)
 *   HOST            bind address (default 127.0.0.1)
 *   LOG_FILE        append-only log path (default ./deploy.log)
 *   OIDC_ISSUER     expected token issuer (default GitHub production)
 *   OIDC_AUDIENCE   expected audience (default https://deploy.umapps.net)
 *   ALLOWED_OWNER   allowed repository_owner org (default ultra-mega-apps)
 *   TLS_CERT/TLS_KEY  optional PEM files to serve HTTPS directly
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authorizeDeployment,
  DEFAULT_ALLOWED_OWNER,
  DEFAULT_AUDIENCE,
  PRODUCTION_ISSUER,
} from './lib/auth.js';

const MAX_BODY_BYTES = 1024 * 1024;

function logLine(logFile, line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  process.stdout.write(stamped + '\n');
  fs.appendFileSync(logFile, stamped + '\n', { encoding: 'utf8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

export function startServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const logFile = opts.logFile ?? process.env.LOG_FILE ?? './deploy.log';
  const issuer = opts.issuer ?? process.env.OIDC_ISSUER ?? PRODUCTION_ISSUER;
  const audience = opts.audience ?? process.env.OIDC_AUDIENCE ?? DEFAULT_AUDIENCE;
  const allowedOwner = opts.allowedOwner ?? process.env.ALLOWED_OWNER ?? DEFAULT_ALLOWED_OWNER;
  const tlsCert = opts.tlsCert ?? process.env.TLS_CERT;
  const tlsKey = opts.tlsKey ?? process.env.TLS_KEY;

  const handler = async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/deploy') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      logLine(logFile, 'DENY reason="invalid JSON body"');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authorized: false, reason: 'invalid JSON body' }));
      return;
    }

    const token = extractBearer(req);
    const result = await authorizeDeployment({ token, body, issuer, audience, allowedOwner });

    if (result.authorized) {
      logLine(
        logFile,
        `ALLOW repository=${result.repository} environment=${result.environment} ref=${result.ref} sha=${result.sha}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else {
      // Missing/malformed credentials -> 401, cryptographically or
      // semantically rejected tokens -> 403.
      const status = result.reason === 'missing token' || result.reason === 'malformed token' ? 401 : 403;
      logLine(logFile, `DENY reason="${result.reason}"`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  };

  const server =
    tlsCert && tlsKey
      ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, handler)
      : http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  startServer()
    .then((server) => {
      const addr = server.address();
      process.stdout.write(`deploy demo listening on ${host}:${typeof addr === 'object' ? addr.port : port}\n`);
    })
    .catch((err) => {
      process.stderr.write(`error: failed to start server: ${err.message}\n`);
      process.exit(1);
    });
}
