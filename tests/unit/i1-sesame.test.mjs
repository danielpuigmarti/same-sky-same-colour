// Names the site does not know itself (site/js/lib/sesame.js): reading the answer of the CDS name resolver, moving
// a star from its position of 2000 to where it is now, and what happens when the resolver does not answer.
// The answers below are the resolver's own, recorded on 14 November 2026 and shortened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESAME_URLS, SESAME_MAX_NAME, parseSesame, positionAt, looksLikeName, resolveName } from '../../site/js/lib/sesame.js';
import { separationDeg } from '../../site/js/lib/gaia.js';

const VEGA = `# Vega	#Q299230
#=Sc=Simbad (CDS, via client/server):    1     0ms (from cache)
%@ @2900336
%C.0 dS*
%J 279.23473479 +38.78368896 = 18 36 56.336  +38 47 01.28
%J.E [3.51 2.81 90] A 2007A&A...474..653V
%P 200.94 286.23 [0.32 0.40 0] A 2007A&A...474..653V
%V v -13.5 C [0.4] 2004A&A...420..183A
%X 130.23 [0.36] A 2007A&A...474..653V
%S A0V C 2024A&A...690A.176N =0.0000C800.0030.0000000000000000
`;
const PROXIMA = `# Proxima Centauri	#Q299232
#=Sc=Simbad (CDS, via client/server):    1     0ms (from cache)
%@ @3379714
%C.0 PM*
%J 217.42894222 -62.67949019 = 14 29 42.946  -62 40 46.16
%J.E [0.0240 0.0344 90] A 2020yCat.1350....0G
%P -3781.741 769.465 [0.031 0.051 90] A 2020yCat.1350....0G
%V v -20.578199 A [0.004684] 2020AJ....160..120J
%X 768.0665 [0.0499] A 2020yCat.1350....0G
`;
const M31 = `# M 31	#Q299231
#=Sc=Simbad (CDS, via client/server):    1   308ms
%@ @1575544
%C.0 AGN
%J 10.68470833 +41.26875000 = 00 42 44.330  +41 16 07.50
%J.E [~ ~ ] C 2006AJ....131.1163S
%V v -300.0 C [4.0] 2012AJ....144....4M
#=N=NED :    1   200ms
%J 10.6847 +41.2690 = 00 42 44.3 +41 16 08
`;
const NOTHING = `# zzznotaname123	#Q299233
#! *** Nothing found ***

#====Done (2026-Nov-14,21:42:24z)====
`;

test('the answer of the resolver is read: position, motion, distance, speed, and which catalogue gave it', () => {
  assert.deepEqual(parseSesame(VEGA), { ra: 279.23473479, dec: 38.78368896, pmra: 200.94, pmdec: 286.23, parallax: 130.23, rv: -13.5, by: 'Simbad' });
  assert.deepEqual(parseSesame(PROXIMA), { ra: 217.42894222, dec: -62.67949019, pmra: -3781.741, pmdec: 769.465, parallax: 768.0665, rv: -20.578199, by: 'Simbad' });
  // the first catalogue that answers is the answer; an object without a motion has none
  assert.deepEqual(parseSesame(M31), { ra: 10.68470833, dec: 41.26875, pmra: null, pmdec: null, parallax: null, rv: -300, by: 'Simbad' });
  assert.equal(parseSesame(NOTHING), null);
  assert.equal(parseSesame(''), null);
  assert.equal(parseSesame('<html>Page unavailable</html>'), null);
  assert.equal(parseSesame('%J 400 10'), null, 'a position that cannot be one');
});

test('a star that moves is moved from 2000 to the epoch asked for; one that does not stays', () => {
  const proxima = /** @type {NonNullable<ReturnType<typeof parseSesame>>} */ (parseSesame(PROXIMA));
  const now = positionAt(proxima, 2026);
  // 3.859 arcsec a year for 26 years
  assert.ok(Math.abs(now.movedArcsec - 26 * Math.hypot(3.781741, 0.769465)) < 0.2, String(now.movedArcsec));
  assert.ok(now.ra < proxima.ra && now.dec > proxima.dec, 'west and north, as its motion says');
  assert.ok(Math.abs(separationDeg(proxima.ra, proxima.dec, now.ra, now.dec) * 3600 - now.movedArcsec) < 1e-9);
  const then = positionAt(proxima, 2000);
  assert.ok(then.movedArcsec < 1e-6 && Math.abs(then.ra - proxima.ra) < 1e-9 && Math.abs(then.dec - proxima.dec) < 1e-9, 'in 2000 it is where the resolver has it');
  const m31 = /** @type {NonNullable<ReturnType<typeof parseSesame>>} */ (parseSesame(M31));
  assert.deepEqual(positionAt(m31, 2026), { ra: m31.ra, dec: m31.dec, movedArcsec: 0 });
  // a motion without a distance still moves the star
  const far = positionAt({ ...proxima, parallax: null, rv: null }, 2026);
  assert.ok(Math.abs(far.movedArcsec - now.movedArcsec) < 0.05);
});

test('only text that can be a name is sent', () => {
  for (const good of ['Vega', 'M 31', 'M31', 'ε Indi', 'NGC 6543', '2MASS J05352184-0546085', '47 Tuc', '3C 273', '51 Peg', 'HD 189733', '1E 0657-56', '1H 0323+342', '4U 1630-47', '10 Dra', 'hello', 'Barnards Sta']) assert.ok(looksLikeName(good), good);
  for (const bad of ['', '   ', '123 456', '10.5 -20', 'x'.repeat(SESAME_MAX_NAME + 1)]) assert.ok(!looksLikeName(bad), bad);
  // a position that cannot be read is not a name: the reader of positions answers it, and it is not sent
  for (const bad of ['25h00m00s +10d00m00s', '10h61m00s +10d00m00s', '10h30m61s +10d00m00s', '12h30m +91d00m', '08h55m10.831s', '12.5h30m +20d', '10h 20m 30s +', 'ra dec', 'RA 25h00m00s Dec +10d00m00s', '1e3 5', '133.7951 deg']) assert.ok(!looksLikeName(bad), bad);
});

test('asking the resolver: the name is sent to the listed addresses only, a redirect is refused, and a failure is a result', async () => {
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  /** @param {(url: string) => Response | Promise<Response>} answer @returns {any} */
  const fetchOf = (answer) => async (/** @type {string} */ url, /** @type {RequestInit} */ init) => { calls.push({ url, init }); return answer(url); };
  const text = (/** @type {string} */ body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

  const found = await resolveName('  Proxima   Centauri ', { fetch: fetchOf(() => text(PROXIMA)) });
  assert.ok(found.ok);
  assert.deepEqual([found.name, found.by, found.epoch], ['Proxima Centauri', 'Simbad', 2026]);
  assert.ok(found.movedArcsec > 99 && found.movedArcsec < 102);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SESAME_URLS[0]}Proxima%20Centauri`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.ok(SESAME_URLS.every((u) => u.startsWith('https://')));

  // the resolver answers that it does not know the name: the other address is not asked
  calls.length = 0;
  assert.deepEqual(await resolveName('zzznotaname123', { fetch: fetchOf(() => text(NOTHING)) }), { ok: false, reason: 'not-found' });
  assert.equal(calls.length, 1);

  // the first address fails, the second answers
  calls.length = 0;
  const second = await resolveName('Vega', { fetch: fetchOf((url) => { if (url.startsWith(SESAME_URLS[0])) throw new TypeError('Failed to fetch'); return text(VEGA); }) });
  assert.ok(second.ok && Math.abs(second.ra - 279.2362) < 0.001);
  assert.deepEqual(calls.map((c) => c.url), SESAME_URLS.map((u) => `${u}Vega`));

  // nobody answers, or what comes back is not an answer of the resolver
  assert.deepEqual(await resolveName('Vega', { fetch: fetchOf(() => { throw new TypeError('Failed to fetch'); }) }), { ok: false, reason: 'unreachable' });
  assert.deepEqual(await resolveName('Vega', { fetch: fetchOf(() => text('<html>Page unavailable</html>')) }), { ok: false, reason: 'unreachable' });
  assert.deepEqual(await resolveName('Vega', { fetch: fetchOf(() => text('', 503)) }), { ok: false, reason: 'unreachable' });
  // an address that never answers is given up on
  const slow = await resolveName('Vega', { timeoutMs: 20, urls: SESAME_URLS.slice(0, 1), fetch: /** @type {any} */ ((/** @type {string} */ u, /** @type {RequestInit} */ init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); })) });
  assert.deepEqual(slow, { ok: false, reason: 'unreachable' });
  // nothing is sent for text that is not a name
  calls.length = 0;
  assert.deepEqual(await resolveName('12 34', { fetch: fetchOf(() => text(VEGA)) }), { ok: false, reason: 'not-a-name' });
  assert.equal(calls.length, 0);
});
