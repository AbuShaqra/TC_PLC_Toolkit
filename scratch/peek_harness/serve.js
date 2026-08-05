/**
 * @file scratch/peek_harness/serve.js
 * @description Static server for the peek harness. Monaco needs a real http origin — its AMD loader
 * and the worker Blob both resolve against it — so file:// will not do.
 *
 * Serves the repo at / (so /media/... resolves exactly as the generated page expects) and the
 * generated harness at /harness/.
 *
 * Run: node scratch/peek_harness/serve.js [port]
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

http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
}).listen(PORT, () => console.log('peek harness on http://localhost:' + PORT + '/harness/'));
