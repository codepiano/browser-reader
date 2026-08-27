import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupStaleSessions, createApp, SESSION_ROOT, SESSION_TTL_MS } from '../src/server.js';

test('health endpoint advertises local-only service', async () => {
  const app = createApp();
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, localOnly: true });
  const missing = await app.inject({ method: 'GET', url: '/api/not-found' });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'Not found' });
  await app.close();
});

test('removes only stale direct UUID sessions and preserves active sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'temporary-reader-cleanup-'));
  const oldId = '11111111-1111-4111-8111-111111111111';
  const freshId = '22222222-2222-4222-8222-222222222222';
  await fs.mkdir(path.join(root, oldId)); await fs.mkdir(path.join(root, freshId));
  const now = Date.now();
  await fs.writeFile(path.join(root, oldId, 'session.json'), JSON.stringify({ updatedAt: new Date(now - SESSION_TTL_MS - 1).toISOString() }));
  await fs.writeFile(path.join(root, freshId, 'session.json'), JSON.stringify({ updatedAt: new Date(now - SESSION_TTL_MS + 1).toISOString() }));
  await fs.mkdir(path.join(root, 'not-a-session'));
  assert.deepEqual(await cleanupStaleSessions(root, now), [oldId]);
  await assert.rejects(fs.access(path.join(root, oldId)));
  await fs.access(path.join(root, freshId));
  await fs.access(path.join(root, 'not-a-session'));
});

test('persists uploaded fonts and restores the active selection', async () => {
  const boundary = 'font-test-boundary';
  const bytes = Buffer.from('font-fixture');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="font"; filename="Fixture.ttf"\r\nContent-Type: font/ttf\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const app = createApp();
  const builtin = await app.inject({ method: 'POST', url: '/api/fonts/active', payload: JSON.stringify({ fontId: 'system-sans' }), headers: { 'content-type': 'application/json' } });
  assert.equal(builtin.statusCode, 200);
  const upload = await app.inject({ method: 'POST', url: '/api/fonts', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  assert.equal(upload.statusCode, 201);
  const font = upload.json() as { id: string; bytes: number; fileName: string };
  assert.equal(font.bytes, bytes.length);
  const active = await app.inject({ method: 'POST', url: '/api/fonts/active', payload: JSON.stringify({ fontId: font.id }), headers: { 'content-type': 'application/json' } });
  assert.equal(active.statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/api/fonts' });
  assert.equal(list.json().activeFontId, font.id);
  const file = await app.inject({ method: 'GET', url: `/api/fonts/${font.id}/file` });
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.rawPayload, bytes);
  const removed = await app.inject({ method: 'DELETE', url: `/api/fonts/${font.id}` });
  assert.equal(removed.statusCode, 200);
  await app.close();
});

test('serves only whitelisted session image assets with MIME and nosniff', async () => {
  const id = '33333333-3333-4333-8333-333333333333'; const assetRoot = path.join(SESSION_ROOT, id, 'assets'); const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(SESSION_ROOT, id, 'session.json'), JSON.stringify({ id, title: 'asset', root: path.join(SESSION_ROOT, id), works: [] }));
  await fs.writeFile(path.join(assetRoot, 'cover.jpg'), bytes);
  const app = createApp();
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}/assets/cover.jpg` });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['content-type'], 'image/jpeg'); assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.deepEqual(response.rawPayload, bytes);
  const missing = await app.inject({ method: 'GET', url: `/api/sessions/${id}/assets/missing.jpg` }); assert.equal(missing.statusCode, 404);
  const escaped = await app.inject({ method: 'GET', url: `/api/sessions/${id}/assets/..%2Fsession.json` }); assert.equal(escaped.statusCode, 404);
  await app.close(); await fs.rm(path.join(SESSION_ROOT, id), { recursive: true, force: true });
});
