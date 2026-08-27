import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupStaleSessions, createApp, SESSION_TTL_MS } from '../src/server.js';

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
