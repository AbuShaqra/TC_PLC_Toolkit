/**
 * @file test/browser/serve.js
 * @description Static server for the peek harness. Monaco needs a real http origin — its AMD loader
 * and the worker Blob both resolve against it — so file:// will not do.
 *
 * Serves the repo at / (so /media/... resolves exactly as the generated page expects) and the
 * generated harness at /harness/.
 *
 * Run standalone to poke at it by hand:  node test/browser/serve.js [port]
 * Or `require()` it and call start(port) — run.js does, so the automated pass needs no side process.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.argv[2] || 8123);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.map': 'application/json; charset=utf-8'
};

function createServer() {
    return http.createServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        // Some Chromium builds request a tab favicon even under automation; a 404 for it lands in
        // the page console and trips run.js's "no browser errors" assertion. There is no icon —
        // answer 204 so the request succeeds without content.
        if (urlPath === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }
        let filePath;
        if (urlPath === '/' || urlPath === '/harness' || urlPath === '/harness/') {
            filePath = path.join(OUT, 'index.html');
        } else if (urlPath.startsWith('/harness/')) {
            filePath = path.join(OUT, urlPath.slice('/harness/'.length));
        } else {
            filePath = path.join(REPO, urlPath);
        }
        // Never serve outside the two roots.
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(REPO) && !resolved.startsWith(OUT)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        fs.readFile(resolved, (err, data) => {
            if (err) { res.writeHead(404).end('not found: ' + urlPath); return; }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream' });
            res.end(data);
        });
    });
}

/**
 * Starts the harness server.
 * @param {number} [port] Port to listen on.
 * @returns {Promise<{server: Object, port: number, url: string}>} Resolves once it is accepting.
 */
function start(port = PORT) {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(port, () => {
            const actual = server.address().port;
            resolve({ server, port: actual, url: `http://localhost:${actual}/harness/` });
        });
    });
}

module.exports = { createServer, start, PORT };

if (require.main === module) {
    start(PORT).then(({ url }) => console.log('peek harness on ' + url));
}
