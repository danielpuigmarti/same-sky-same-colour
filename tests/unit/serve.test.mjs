// The development server (tools/serve.mjs) sends the files of a folder as they are, and nothing outside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../tools/serve.mjs';

/** @param {string} base */
async function serving(base) {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-'));
  mkdirSync(path.join(root, 'site', 'data'), { recursive: true });
  writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html><title>home</title>');
  writeFileSync(path.join(root, 'site', 'data', 'a.json'), '{"a": 1}');
  writeFileSync(path.join(root, 'site', 'data', 't.json.gz'), Buffer.from([0x1f, 0x8b, 8, 0]));
  writeFileSync(path.join(root, 'secret.txt'), 'not part of the site');
  const { server, url } = await startServer({ root: path.join(root, 'site'), port: 0, base });
  return { url, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('files are sent with their type, a folder sends its index.html, a missing file is 404', async () => {
  const s = await serving('/');
  try {
    const home = await fetch(s.url);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await home.text(), '<!doctype html><title>home</title>');
    const json = await fetch(`${s.url}data/a.json?x=1`);
    assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await json.json(), { a: 1 });
    const gz = await fetch(`${s.url}data/t.json.gz`);
    assert.equal(gz.headers.get('content-type'), 'application/gzip');
    assert.equal(gz.headers.get('content-encoding'), null, 'a .gz file is sent as it is; the page unpacks it');
    assert.equal((await gz.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${s.url}absent.html`)).status, 404);
    assert.equal((await fetch(`${s.url}data`, { redirect: 'manual' })).status, 301);
    const head = await fetch(s.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(s.url, { method: 'POST' })).status, 405);
  } finally { s.close(); }
});

test('nothing outside the folder is sent', async () => {
  const s = await serving('/');
  try {
    for (const p of ['..%2Fsecret.txt', '%2e%2e/secret.txt', '..%5Csecret.txt', 'data/..%2F..%2Fsecret.txt']) {
      const r = await fetch(s.url + p);
      assert.ok(r.status === 403 || r.status === 404, `${p}: ${r.status}`);
      assert.notEqual(await r.text(), 'not part of the site');
    }
  } finally { s.close(); }
});

test('under a folder, the site answers there and nowhere else', async () => {
  const s = await serving('/name/');
  try {
    assert.ok(s.url.endsWith('/name/'));
    assert.equal((await fetch(s.url)).status, 200);
    assert.equal((await fetch(`${s.url}data/a.json`)).status, 200);
    const origin = new URL(s.url).origin;
    assert.equal((await fetch(`${origin}/data/a.json`)).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    const r = await fetch(`${origin}/name`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/name/');
  } finally { s.close(); }
});
