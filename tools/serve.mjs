#!/usr/bin/env node
// Serves site/ on this computer, for development and for the browser tests. Nothing is built: the files are
// sent as they are, as the public host sends them.
//
//   node tools/serve.mjs                    http://127.0.0.1:8080/
//   node tools/serve.mjs --port 9000
//   node tools/serve.mjs --base /folder/    the site under a folder, as on a host that serves it at /name/;
//                                           an address that starts with "/" then fails here as it would there
//   node tools/serve.mjs --root other/dir   another folder than site/
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
};

/**
 * Start the server.
 * @param {{root: string, port?: number, base?: string, host?: string, log?: (line: string) => void}} options
 * @returns {Promise<{server: import('node:http').Server, url: string}>}
 */
export function startServer({ root, port = 8080, base = '/', host = '127.0.0.1', log = () => {} }) {
  const folder = path.resolve(root);
  const prefix = `/${base.split('/').filter(Boolean).join('/')}${base.replace(/\//g, '') ? '/' : ''}`;

  const server = createServer((req, res) => {
    /** @param {number} status @param {string} text */
    const plain = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : `${text}\n`);
      log(`${status} ${req.method} ${req.url}`);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Only GET and HEAD.');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); } catch { return plain(400, 'Bad address.'); }
    if (`${pathname}/` === prefix) { res.writeHead(301, { location: prefix }); res.end(); return undefined; }
    if (!pathname.startsWith(prefix)) return plain(404, `Not found. The site is at ${prefix}`);
    let file = path.resolve(folder, `.${path.sep}${pathname.slice(prefix.length)}`);
    if (file !== folder && !file.startsWith(folder + path.sep)) return plain(403, 'Outside the site.');
    let stat;
    try {
      stat = statSync(file);
      if (stat.isDirectory()) {
        if (!pathname.endsWith('/')) { res.writeHead(301, { location: `${pathname}/` }); res.end(); return undefined; }
        file = path.join(file, 'index.html');
        stat = statSync(file);
      }
    } catch { return plain(404, 'Not found.'); }
    res.writeHead(200, {
      'content-type': TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file).toLowerCase())] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    log(`200 ${req.method} ${req.url}`);
    if (req.method === 'HEAD') { res.end(); return undefined; }
    pipeline(createReadStream(file), res, () => {});
    return undefined;
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, url: `http://${host}:${address.port}${prefix}` });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @param {string} name @param {string} fallback */
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { url } = await startServer({
    root: path.resolve(option('--root', path.join(here, '..', 'site'))),
    port: Number(option('--port', process.env.PORT ?? '8080')),
    base: option('--base', '/'),
    log: args.includes('--quiet') ? undefined : (line) => console.log(line),
  });
  console.log(`Serving the site at ${url}  (Ctrl+C stops it)`);
}
