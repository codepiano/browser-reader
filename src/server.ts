import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { importEpub, importMarkdownDirectory } from './importers.js';
import { ReadingLocation, Session, Work } from './types.js';
import { inside, safeRelative } from './safety.js';

export const SESSION_ROOT = path.join(os.tmpdir(), 'temporary-book-reader-sessions');
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DATA_ROOT = path.resolve('data');
export const FONT_ROOT = path.join(DATA_ROOT, 'fonts');
export const FONT_MANIFEST = path.join(DATA_ROOT, 'fonts.json');
const FONT_TYPES: Record<string, { format: string; contentType: string }> = {
  '.woff2': { format: 'woff2', contentType: 'font/woff2' },
  '.woff': { format: 'woff', contentType: 'font/woff' },
  '.ttf': { format: 'truetype', contentType: 'font/ttf' },
  '.otf': { format: 'opentype', contentType: 'font/otf' }
};
const BUILTIN_FONT_IDS = new Set(['system-serif', 'system-sans', 'system-mono']);
const MAX_FONT_BYTES = 50 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function cleanupStaleSessions(root = SESSION_ROOT, now = Date.now()): Promise<string[]> {
  await fs.mkdir(root, { recursive: true });
  const removed: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const sessionRoot = inside(root, entry.name);
    let lastActivity = 0;
    try {
      const stat = await fs.stat(path.join(sessionRoot, 'session.json'));
      const metadata = JSON.parse(await fs.readFile(path.join(sessionRoot, 'session.json'), 'utf8')) as { updatedAt?: string };
      lastActivity = metadata.updatedAt ? Date.parse(metadata.updatedAt) : stat.mtimeMs;
      if (!Number.isFinite(lastActivity) || lastActivity <= 0) lastActivity = stat.mtimeMs;
    } catch {
      lastActivity = (await fs.stat(sessionRoot)).mtimeMs;
    }
    if (now - lastActivity > SESSION_TTL_MS) {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

async function writeJson(file: string, value: unknown): Promise<void> { await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8'); }
async function writeJsonAtomic(file: string, value: unknown): Promise<void> { const temporary = `${file}.${process.pid}.tmp`; await fs.mkdir(path.dirname(file), { recursive: true }); await writeJson(temporary, value); await fs.rename(temporary, file); }
async function readSession(id: string): Promise<Session> { const root = inside(SESSION_ROOT, id); return JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8')) as Session; }
function publicSession(session: Session): Omit<Session, 'root'> { const { root: _root, ...safe } = session; return safe; }
function findWork(session: Session, workId: string | undefined): Work { const work = session.works.find((candidate) => candidate.id === workId) ?? session.works[0]; if (!work) throw new Error('No readable work'); return work; }
const ASSET_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
type StoredFont = { id: string; label: string; family: string; format: string; extension: string; fileName: string; bytes: number; createdAt: string };
type FontSettings = { activeFontId: string };
async function readFonts(): Promise<StoredFont[]> { try { return JSON.parse(await fs.readFile(FONT_MANIFEST, 'utf8')) as StoredFont[]; } catch { return []; } }
async function readFontSettings(fonts: StoredFont[]): Promise<FontSettings> { try { const settings = JSON.parse(await fs.readFile(path.join(DATA_ROOT, 'settings.json'), 'utf8')) as FontSettings; if (BUILTIN_FONT_IDS.has(settings.activeFontId) || fonts.some((font) => font.id === settings.activeFontId)) return settings; } catch { /* use default */ } return { activeFontId: 'system-serif' }; }
async function writeFontSettings(settings: FontSettings): Promise<void> { await writeJsonAtomic(path.join(DATA_ROOT, 'settings.json'), settings); }

export function createApp() {
  const app = Fastify({ logger: false, bodyLimit: 250 * 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: 250 * 1024 * 1024, files: 5000, fields: 20 } });
  app.get('/api/health', async () => ({ ok: true, localOnly: true }));
  app.get('/api/fonts', async () => { const fonts = await readFonts(); const settings = await readFontSettings(fonts); return { activeFontId: settings.activeFontId, fonts }; });
  app.post('/api/fonts', async (request, reply) => {
    try {
      let uploadName = ''; let buffer: Buffer | undefined;
      for await (const part of request.parts()) { if (part.type === 'file' && !buffer) { uploadName = part.filename; buffer = await part.toBuffer(); } else if (part.type === 'file') await part.toBuffer(); }
      if (!buffer) return reply.code(400).send({ error: '请选择字体文件' });
      const extension = path.extname(uploadName).toLowerCase(); const type = FONT_TYPES[extension];
      if (!type) return reply.code(400).send({ error: '字体格式不支持，请选择 WOFF2、WOFF、TTF 或 OTF 文件。' });
      if (!buffer.length || buffer.length > MAX_FONT_BYTES) return reply.code(400).send({ error: '字体文件必须大于 0 且不超过 50 MB。' });
      await fs.mkdir(FONT_ROOT, { recursive: true }); const id = `font-${crypto.randomUUID()}`; const fileName = `${id}${extension}`; await fs.writeFile(inside(FONT_ROOT, fileName), buffer);
      const font: StoredFont = { id, label: path.basename(uploadName, extension) || '未命名字体', family: `Reader Uploaded ${id.slice(-12)}`, format: type.format, extension, fileName, bytes: buffer.length, createdAt: new Date().toISOString() };
      const fonts = await readFonts(); fonts.push(font); await writeJsonAtomic(FONT_MANIFEST, fonts); return reply.code(201).send(font);
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '字体导入失败' }); }
  });
  app.get('/api/fonts/:id/file', async (request, reply) => { try { const id = (request.params as { id: string }).id; const font = (await readFonts()).find((candidate) => candidate.id === id); if (!font) return reply.code(404).send({ error: 'Font not found' }); const type = FONT_TYPES[font.extension]; const buffer = await fs.readFile(inside(FONT_ROOT, font.fileName)); return reply.header('Content-Type', type.contentType).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=31536000, immutable').send(buffer); } catch { return reply.code(404).send({ error: 'Font not found' }); } });
  app.post('/api/fonts/active', async (request, reply) => { try { const fontId = (request.body as { fontId?: string })?.fontId; const fonts = await readFonts(); if (!fontId || (!BUILTIN_FONT_IDS.has(fontId) && !fonts.some((font) => font.id === fontId))) return reply.code(404).send({ error: 'Font not found' }); await writeFontSettings({ activeFontId: fontId }); return { activeFontId: fontId }; } catch { return reply.code(400).send({ error: '字体设置失败' }); } });
  app.delete('/api/fonts/:id', async (request, reply) => { try { const id = (request.params as { id: string }).id; const fonts = await readFonts(); const font = fonts.find((candidate) => candidate.id === id); if (!font) return reply.code(404).send({ error: 'Font not found' }); await fs.rm(inside(FONT_ROOT, font.fileName), { force: true }); await writeJsonAtomic(FONT_MANIFEST, fonts.filter((candidate) => candidate.id !== id)); const settings = await readFontSettings(fonts); if (settings.activeFontId === id) await writeFontSettings({ activeFontId: 'system-serif' }); return { deleted: true }; } catch { return reply.code(404).send({ error: 'Font not found' }); } });
  app.post('/api/import', async (request, reply) => {
    const id = crypto.randomUUID(); const root = inside(SESSION_ROOT, id); const incoming = inside(root, 'incoming');
    await fs.mkdir(incoming, { recursive: true });
    let kind = ''; let sourceName = 'Untitled'; let epubFile = '';
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') { if (part.fieldname === 'kind') kind = String(part.value); continue; }
        const relative = safeRelative(part.filename || 'upload'); sourceName = sourceName === 'Untitled' ? path.posix.basename(relative) : sourceName;
        const target = inside(incoming, relative); await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await part.toBuffer());
        if (/\.epub$/i.test(relative)) epubFile = target;
      }
      let works: Work[];
      if (kind === 'epub' || epubFile) works = await importEpub(epubFile || inside(incoming, sourceName), root, sourceName);
      else works = await importMarkdownDirectory(incoming, sourceName, root);
      const now = new Date().toISOString();
      const session: Session = { id, title: works[0]?.title || sourceName, sourceName, createdAt: now, updatedAt: now, root, works, selectedWorkId: works[0]?.id, currentChapter: 0 };
      await writeJson(path.join(root, 'session.json'), session);
      return reply.code(201).send(publicSession(session));
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Import failed' });
    }
  });
  app.get('/api/sessions/:id', async (request, reply) => {
    try { return publicSession(await readSession((request.params as { id: string }).id)); } catch { return reply.code(404).send({ error: 'Session not found' }); }
  });
  app.get('/api/sessions/:id/chapter/:index', async (request, reply) => {
    try {
      const params = request.params as { id: string; index: string }; const session = await readSession(params.id);
      const query = request.query as { work?: string }; const work = findWork(session, query.work); const index = Number(params.index);
      if (!Number.isInteger(index) || index < 0 || index >= work.chapters.length) return reply.code(404).send({ error: 'Chapter not found' });
      const chapter = work.chapters[index]; const markdown = await fs.readFile(inside(session.root, chapter.file), 'utf8');
      session.selectedWorkId = work.id; session.currentChapter = index; session.locations = session.locations ?? {}; const previous = session.locations[work.id]; session.locations[work.id] = { chapter: index, scrollRatio: previous?.chapter === index ? previous.scrollRatio : 0, updatedAt: new Date().toISOString() }; session.updatedAt = new Date().toISOString(); await writeJson(path.join(session.root, 'session.json'), session);
      return { sessionId: session.id, workId: work.id, workTitle: work.title, chapter, markdown, total: work.chapters.length, warning: chapter.resourceBase === undefined ? '该会话创建于本地图片支持之前，请重新导入以显示图片。' : undefined };
    } catch { return reply.code(404).send({ error: 'Session or chapter not found' }); }
  });
  app.post('/api/sessions/:id/progress', async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id; const session = await readSession(id); const body = request.body as { workId?: string; chapter?: number; scrollRatio?: number }; const work = findWork(session, body.workId);
      const chapter = Number(body.chapter); const scrollRatio = Number(body.scrollRatio);
      if (!Number.isInteger(chapter) || chapter < 0 || chapter >= work.chapters.length || !Number.isFinite(scrollRatio)) return reply.code(400).send({ error: 'Invalid reading progress' });
      const location: ReadingLocation = { chapter, scrollRatio: Math.max(0, Math.min(1, scrollRatio)), updatedAt: new Date().toISOString() };
      session.selectedWorkId = work.id; session.currentChapter = chapter; session.locations = { ...(session.locations ?? {}), [work.id]: location }; session.updatedAt = location.updatedAt; await writeJson(path.join(session.root, 'session.json'), session); return { saved: true, location };
    } catch { return reply.code(404).send({ error: 'Session not found' }); }
  });
  app.get('/api/sessions/:id/assets/*', async (request, reply) => {
    try {
      const params = request.params as { id: string; '*': string }; const session = await readSession(params.id);
      const relative = safeRelative(params['*']); const extension = path.extname(relative).toLowerCase(); const contentType = ASSET_TYPES[extension];
      if (!contentType) return reply.code(404).type('application/json').send({ error: 'Asset not found' });
      const asset = inside(session.root, path.posix.join('assets', relative)); const stat = await fs.stat(asset);
      if (!stat.isFile()) return reply.code(404).type('application/json').send({ error: 'Asset not found' });
      reply.header('Content-Type', contentType).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=3600');
      return reply.send(await fs.readFile(asset));
    } catch { return reply.code(404).type('application/json').send({ error: 'Asset not found' }); }
  });
  app.post('/api/sessions/:id/select', async (request, reply) => {
    try { const id = (request.params as { id: string }).id; const session = await readSession(id); const body = request.body as { workId?: string; chapter?: number }; const work = findWork(session, body.workId); session.selectedWorkId = work.id; session.currentChapter = Math.max(0, Math.min(body.chapter ?? 0, work.chapters.length - 1)); session.updatedAt = new Date().toISOString(); await writeJson(path.join(session.root, 'session.json'), session); return publicSession(session); } catch { return reply.code(404).send({ error: 'Session not found' }); }
  });
  app.delete('/api/sessions/:id', async (request, reply) => { try { const id = (request.params as { id: string }).id; await fs.rm(inside(SESSION_ROOT, id), { recursive: true, force: true }); return { deleted: true }; } catch { return reply.code(404).send({ error: 'Session not found' }); } });
  const publicRoot = path.resolve('dist/public');
  app.register(fastifyStatic, { root: publicRoot, prefix: '/' });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).type('application/json').send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
  return app;
}

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  await cleanupStaleSessions();
  const app = createApp();
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT || 4321) });
  console.log('Temporary Book Reader listening at http://127.0.0.1:4321');
}
