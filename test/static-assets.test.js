import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function withPublicServer(run) {
  const store = new Store();
  const app = createApp({ store, workerMode: 'disabled' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise(resolve => app.close(resolve));
    store.close();
  }
}

test('hosted entry opens the website and keeps the feature flag software reachable', async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    await withPublicServer(async base => {
      const home = await fetch(base + '/');
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /Open your workspace/);
      assert.match(html, /href="\/agents"/);
      assert.match(html, /href="\/flags"/);
      const flags = await fetch(base + '/flags');
      assert.equal(flags.status, 200);
      assert.match(await flags.text(), /src="\/app.js"/);
      assert.equal((await fetch(base + '/api/flags')).status, 401);
    });
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test('welcome fonts and media are public with correct MIME types and unchanged security headers', async () => {
  await withPublicServer(async base => {
    for (const [path, type] of [
      ['/pogonia-regular.otf', 'font/otf'],
      ['/pogonia-semibold.otf', 'font/otf'],
      ['/tour-poster.png', 'image/png'],
      ['/studio-preview.png', 'image/png'],
      ['/tour.vtt', 'text/vtt; charset=utf-8']
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), type, path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      assert.ok((await response.arrayBuffer()).byteLength > 0, path);
    }
    const page = await fetch(base + '/welcome', { headers: { Range: 'bytes=0-15' } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('accept-ranges'), null);
    assert.match(await page.text(), /<!doctype html>/i);
    assert.equal((await fetch(base + '/api/flags')).status, 401);
  });
});

test('tour video serves exact full and partial bytes and rejects invalid ranges', async () => {
  const video = await readFile(new URL('../public/tour.webm', import.meta.url));
  assert.ok(video.length > 32);
  await withPublicServer(async base => {
    const full = await fetch(base + '/tour.webm');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/webm');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(Number(full.headers.get('content-length')), video.length);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);

    for (const [range, start, end] of [
      ['bytes=0-31', 0, 31],
      [`bytes=${video.length - 32}-`, video.length - 32, video.length - 1],
      ['bytes=-32', video.length - 32, video.length - 1],
      [`bytes=${video.length - 8}-${video.length + 128}`, video.length - 8, video.length - 1],
      [`bytes=-${video.length + 128}`, 0, video.length - 1]
    ]) {
      const response = await fetch(base + '/tour.webm', { headers: { Range: range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
      assert.equal(Number(response.headers.get('content-length')), end - start + 1);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, end + 1));
    }

    for (const range of [`bytes=${video.length}-`, 'bytes=31-0', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=9007199254740992-']) {
      const response = await fetch(base + '/tour.webm', { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-range'), `bytes */${video.length}`);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });
});
