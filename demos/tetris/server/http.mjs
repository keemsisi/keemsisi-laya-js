/* ------------------------------------------------------------------ *
 * http.mjs - HTTP plumbing, and nothing about Laya.
 *
 * CORS, JSON replies, a size-capped body reader and static file
 * serving. One reason to change: how bytes get on and off the wire.
 * Nothing here knows what a decision is.
 * ------------------------------------------------------------------ */

import fs from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon'
};

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export function json(res, code, body) {
  const s = JSON.stringify(body);
  cors(res);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s)
  });
  res.end(s);
}

/**
 * Read a request body, refusing to buffer more than `limit`.
 *
 * Streamed and abandoned the moment it passes the cap rather than checked
 * against content-length: that header is the client's to choose and chunked
 * encoding omits it, so trusting it would leave the cap unenforced.
 */
export async function readBody(req, limit) {
  const cap = limit || 256 * 1024;
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new Error('payload too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Serve files from `root`, and only from `root`.
 *
 * `path.resolve` collapses any `..` the caller sent; the prefix check then
 * rejects anything that still lands outside the directory.
 */
export function createStaticServer(root, mime) {
  const table = mime || MIME;
  return async function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) && full !== path.join(root, 'index.html')) {
      return json(res, 403, { error: 'forbidden' });
    }
    try {
      const data = await fs.readFile(full);
      cors(res);
      res.writeHead(200, {
        'content-type': table[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-cache'
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not found', path: rel });
    }
  };
}
