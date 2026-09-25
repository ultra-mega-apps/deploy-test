/**
 * Minimal test application.
 *
 * A plain Node.js app that answers "Hello World" on port 3000.
 * It knows nothing about deploys, OIDC or JWT; the deploy workflow
 * (`.github/workflows/deploy.yml`) is the only deploy-related piece here.
 */

import http from 'node:http';

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello World\n');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Hello World app listening on http://0.0.0.0:${port}`);
});
