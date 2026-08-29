import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import TurndownService from 'turndown';
import { Chapter, Work } from './types.js';
import { inside, safeRelative, slug } from './safety.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);

function array<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function countWords(markdown: string): number { return markdown.replace(/\s+/g, '').length; }
const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
function imageType(file: string): string | undefined { return IMAGE_TYPES[path.posix.extname(file).toLowerCase()]; }
function localImageReference(reference: string): string | undefined {
  const value = reference.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
  if (!value || /^(?:https?:|data:|file:|javascript:|blob:)/i.test(value)) return undefined;
  try { const decoded = decodeURIComponent(value); return decoded.startsWith('/') || decoded.includes('\0') ? undefined : decoded; } catch { return undefined; }
}
function imageReferences(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) { const ref = localImageReference(match[1] || match[2]); if (ref && imageType(ref)) found.add(ref); }
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) { const ref = localImageReference(match[1]); if (ref && imageType(ref)) found.add(ref); }
  return [...found];
}
async function copyMarkdownImages(markdown: string, contentRoot: string, sourceBase: string, destination: string): Promise<void> {
  for (const reference of imageReferences(markdown)) {
    let sourcePath: string;
    try { sourcePath = safeRelative(path.posix.normalize(path.posix.join(sourceBase, reference))); } catch { continue; }
    const source = inside(contentRoot, sourcePath);
    const target = inside(destination, `assets/${sourcePath}`);
    try { const stat = await fs.stat(source); if (!stat.isFile()) continue; await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); } catch { /* missing local images remain unavailable */ }
  }
}

export async function importMarkdownDirectory(root: string, sourceName: string, destination: string): Promise<Work[]> {
  const config = await readGitbookConfig(root);
  const contentRoot = config.root ? inside(root, config.root) : root;
  const files = await walk(contentRoot);
  const mdFiles = files.filter((file) => /\.md$/i.test(file));
  if (!mdFiles.length) throw new Error('Markdown directory contains no .md files');
  const configuredSummary = config.summary ? safeRelative(config.summary) : '';
  const configuredReadme = config.readme ? safeRelative(config.readme) : '';
  const summary = configuredSummary || files.find((file) => /(^|\/)SUMMARY\.md$/i.test(file));
  const defaultReadme = files.find((file) => /(^|\/)README\.md$/i.test(file)) || '';
  const readme = configuredReadme || (!summary ? defaultReadme : '');
  const ordered = summary ? parseSummary(await fs.readFile(inside(contentRoot, summary), 'utf8'), path.posix.dirname(summary)) : readme && mdFiles.includes(readme) ? [{ file: readme, title: titleFromPath(readme), level: 1 }] : [];
  const used = new Set(ordered.map((entry) => entry.file));
  const navigationFile = summary;
  const rest = mdFiles.filter((file) => !used.has(file) && file !== navigationFile).sort((a, b) => a.localeCompare(b));
  const entries = [...ordered, ...rest.map((file) => ({ file, title: titleFromPath(file), level: 1 }))];
  const displayName = /^(summary|readme)(?:\.[^.]+)?$/i.test(sourceName) ? 'Markdown book' : sourceName;
  const workId = slug(displayName.replace(/\.[^.]+$/, ''), 'markdown-book');
  const chapters: Chapter[] = [];
  for (const [index, entry] of entries.entries()) {
    const relative = safeRelative(entry.file);
    const markdown = await fs.readFile(inside(contentRoot, relative), 'utf8');
    if (!markdown.trim()) continue;
    const id = `${String(index + 1).padStart(3, '0')}-${slug(entry.title)}`;
    const file = `works/${workId}/chapters/${id}.md`;
    const target = inside(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, markdown, 'utf8');
    await copyMarkdownImages(markdown, contentRoot, path.posix.dirname(relative), destination);
    chapters.push({ id, title: entry.title, level: entry.level, file, order: chapters.length, wordCount: countWords(markdown), sourcePath: relative, resourceBase: path.posix.dirname(relative) });
  }
  return [{ id: workId, title: titleFromPath(displayName), chapters, source: 'markdown' }];
}

type SplitMarkdownChapter = { number: string; title: string; markdown: string };

const MARKDOWN_HEADING_RE = /^\s*#{1,6}\s+.*$/;
const CHAPTER_TITLE_RE = /^第([一二三四五六七八九十百千万零〇两0-9]+)章(?:[\s：:.-—–]*(.*))?$/;

function normalizeMarkdownHeading(line: string): string {
  return line.trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/<a\b[^>]*><\/a>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/[*_]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitMarkdownChapters(markdown: string): SplitMarkdownChapter[] {
  const lines = markdown.split(/(?<=\n)/);
  const chapters: SplitMarkdownChapter[] = [];
  let current: SplitMarkdownChapter | undefined;

  for (const line of lines) {
    if (MARKDOWN_HEADING_RE.test(line.trimEnd())) {
      const heading = normalizeMarkdownHeading(line);
      const match = heading.match(CHAPTER_TITLE_RE);
      if (match) {
        if (current) chapters.push({ ...current, markdown: current.markdown.trim() });
        const number = match[1];
        const title = `第${number}章${match[2] ? ` ${match[2].trim()}` : ''}`;
        current = { number, title, markdown: `# ${title}\n` };
        continue;
      }
    }
    if (current) current.markdown += line;
  }
  if (current) chapters.push({ ...current, markdown: current.markdown.trim() });
  return chapters.filter((chapter) => chapter.markdown.replace(/^# [^\n]+\n?/, '').trim());
}

export async function importMarkdownFile(file: string, sourceName: string, destination: string): Promise<Work[]> {
  const original = await fs.readFile(file, 'utf8');
  const split = splitMarkdownChapters(original);
  const displayName = titleFromPath(sourceName);
  const workId = slug(displayName, 'markdown-book');
  const chapters: Chapter[] = [];
  const entries = split.length ? split : [{ number: '1', title: titleFromPath(sourceName), markdown: original.trim() }];

  for (const [index, entry] of entries.entries()) {
    if (!entry.markdown) continue;
    const id = `${String(index + 1).padStart(3, '0')}-${slug(entry.title)}`;
    const chapterFile = `works/${workId}/chapters/${id}.md`;
    const target = inside(destination, chapterFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.markdown, 'utf8');
    await copyMarkdownImages(entry.markdown, path.dirname(file), '.', destination);
    chapters.push({ id, title: entry.title, level: 1, file: chapterFile, order: chapters.length, wordCount: countWords(entry.markdown), sourcePath: path.basename(file), resourceBase: '.' });
  }
  if (!chapters.length) throw new Error('Markdown file contains no readable chapters');
  return [{ id: workId, title: displayName, chapters, source: 'markdown' }];
}

type GitbookConfig = { root?: string; summary?: string; readme?: string };
async function readGitbookConfig(root: string): Promise<GitbookConfig> {
  let content: string;
  try { content = await fs.readFile(path.join(root, '.gitbook.yaml'), 'utf8'); } catch { try { content = await fs.readFile(path.join(root, '.gitbook.yml'), 'utf8'); } catch { return {}; } }
  const result: GitbookConfig = {};
  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const sectionMatch = line.match(/^([A-Za-z][\w-]*):\s*$/);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const match = line.match(/^\s*([A-Za-z][\w-]*):\s*["']?([^"'\s#]+)["']?\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^\.\//, '');
    if (section === 'structure' && match[1] === 'summary') result.summary = value;
    else if (section === 'structure' && match[1] === 'readme') result.readme = value;
    else if (!section && match[1] === 'root') result.root = value;
  }
  if (result.root) safeRelative(result.root);
  if (result.summary) safeRelative(result.summary);
  if (result.readme) safeRelative(result.readme);
  return result;
}

function parseSummary(markdown: string, base: string): Array<{ file: string; title: string; level: number }> {
  const entries: Array<{ file: string; title: string; level: number }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^(\s*)[-*+]\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (!match) continue;
    const target = decodeURIComponent(match[3].split('#')[0].trim());
    if (!/\.md$/i.test(target)) continue;
    try { entries.push({ file: path.posix.normalize(path.posix.join(base, safeRelative(target))), title: match[2].trim(), level: Math.floor(match[1].length / 2) + 1 }); } catch { /* skip unsafe links */ }
  }
  return entries;
}

async function walk(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(inside(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(root, child));
    else result.push(child.replaceAll('\\', '/'));
  }
  return result;
}

function titleFromPath(file: string): string { return path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') || 'Untitled'; }
function sourceTitleFromXhtml(raw: string): string {
  const match = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
}
function bodyFromXhtml(raw: string): string { return raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? raw; }

type TocNode = { href: string; title: string; level: number; children: TocNode[] };

export async function importEpub(file: string, destination: string, sourceName: string): Promise<Work[]> {
  const zip = new AdmZip(file);
  const names = zip.getEntries().map((entry) => entry.entryName.replaceAll('\\', '/'));
  if (names.some((name) => name.includes('..') || name.startsWith('/'))) throw new Error('EPUB contains unsafe paths');
  if (names.some((name) => /(^|\/)(encryption|rights)\.xml$/i.test(name))) throw new Error('Encrypted/DRM EPUB is not supported');
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) throw new Error('Invalid EPUB: missing container.xml');
  const container = xml.parse(containerEntry.getData().toString('utf8'));
  const rootfile = array(container.container?.rootfiles?.rootfile)[0] as Record<string, string> | undefined;
  const opfPath = rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('Invalid EPUB: missing OPF package');
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error('Invalid EPUB: OPF not found');
  const opf = xml.parse(opfEntry.getData().toString('utf8'));
  const pkg = opf.package;
  const metadata = pkg.metadata ?? {};
  const title = text(metadata.title) || titleFromPath(sourceName);
  const manifest: Record<string, Record<string, string>> = {};
  for (const item of array(pkg.manifest?.item)) { const value = item as Record<string, string>; if (value['@_id']) manifest[value['@_id']] = value; }
  const spine = array(pkg.spine?.itemref).map((item) => String((item as Record<string, string>)['@_idref'] ?? '')).filter(Boolean);
  if (!spine.length) throw new Error('EPUB has no readable spine');
  const base = path.posix.dirname(opfPath);
  const navId = Object.keys(manifest).find((id) => /nav/.test(manifest[id]['@_properties'] ?? ''));
  const ncxId = String(pkg.spine?.['@_toc'] ?? '');
  const tocRoots = navId ? parseNav(zip, path.posix.join(base, manifest[navId]['@_href'])) : ncxId ? parseNcx(zip, path.posix.join(base, manifest[ncxId]?.['@_href'] ?? '')) : [];
  const toc = flattenToc(tocRoots);
  const workId = slug(sourceName.replace(/\.[^.]+$/, ''), 'epub-book');
  const chapters: Chapter[] = [];
  const imageManifest = Object.values(manifest).filter((item) => /^image\//i.test(item['@_media-type'] ?? '') && imageType(item['@_href'] ?? ''));
  for (const item of imageManifest) {
    const sourcePath = path.posix.normalize(path.posix.join(base, decodeURIComponent(item['@_href'])));
    const entry = zip.getEntry(sourcePath); if (!entry) continue;
    const target = inside(destination, `assets/${sourcePath}`); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, entry.getData());
  }
  for (const [index, idref] of spine.entries()) {
    const item = manifest[idref]; if (!item?.['@_href']) continue;
    const sourcePath = path.posix.normalize(path.posix.join(base, item['@_href'].split('#')[0]));
    const entry = zip.getEntry(sourcePath); if (!entry) continue;
    const raw = entry.getData().toString('utf8');
    const sourceTitle = sourceTitleFromXhtml(raw);
    const markdown = turndown.turndown(bodyFromXhtml(raw)).trim();
    if (!markdown) continue;
    const tocItem = toc.find((candidate) => path.posix.normalize(candidate.href.split('#')[0]) === sourcePath);
    const chapterTitle = tocItem?.title || firstHeading(markdown) || (sourceTitle && !isPlaceholderTitle(sourceTitle) ? sourceTitle : '') || `Chapter ${index + 1}`;
    const id = `${String(index + 1).padStart(3, '0')}-${slug(chapterTitle)}`;
    const file = `works/${workId}/chapters/${id}.md`;
    const target = inside(destination, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, markdown, 'utf8');
    chapters.push({ id, title: chapterTitle, level: tocItem?.level ?? 1, file, order: chapters.length, wordCount: countWords(markdown), sourcePath, resourceBase: path.posix.dirname(sourcePath), sourceTitle: sourceTitle || undefined });
  }
  if (!chapters.length) throw new Error('EPUB has no readable text chapters');
  const groups = tocRoots.filter((node) => node.children.length > 0).map((node) => {
    const indexes = flattenToc([node]).map((candidate) => toc.findIndex((item) => item === candidate)).filter((index) => index >= 0);
    const spineIndexes = indexes.map((index) => toc[index]).map((candidate) => spine.findIndex((idref) => path.posix.normalize(path.posix.join(base, manifest[idref]?.['@_href']?.split('#')[0] ?? '')) === path.posix.normalize(candidate.href.split('#')[0]))).filter((index) => index >= 0);
    return { node, start: spineIndexes.length ? Math.min(...spineIndexes) : -1, end: spineIndexes.length ? Math.max(...spineIndexes) : -1 };
  }).filter((group) => group.start >= 0 && group.end >= group.start);
  if (groups.length >= 2) {
    const valid = groups.sort((a, b) => a.start - b.start).filter((group, index, list) => index === 0 || group.start > list[index - 1].end).filter((group) => chapters.slice(group.start, group.end + 1).length > 0);
    if (valid.length >= 2) return valid.map((group, index) => ({ id: `${workId}-${index + 1}`, title: group.node.title || `Part ${index + 1}`, chapters: chapters.slice(group.start, group.end + 1).map((chapter, order) => ({ ...chapter, order })), source: 'epub' }));
  }
  return [{ id: workId, title, chapters, source: 'epub' }];
}

function firstHeading(markdown: string): string { return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''; }
function isPlaceholderTitle(value: string): boolean { return /^(?:未知|无标题|untitled|unknown|n\/a)$/i.test(value.trim()); }
function flattenToc(nodes: TocNode[]): TocNode[] { return nodes.flatMap((node) => [node, ...flattenToc(node.children)]); }
function parseNav(zip: AdmZip, file: string): TocNode[] {
  const entry = zip.getEntry(file); if (!entry) return [];
  const html = entry.getData().toString('utf8'); const flat: TocNode[] = []; let depth = 0;
  for (const match of html.matchAll(/<ol\b[^>]*>|<\/ol>|<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (match[0].startsWith('<ol')) depth++;
    else if (match[0].startsWith('</ol')) depth = Math.max(0, depth - 1);
    else flat.push({ href: path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])), title: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), level: Math.max(depth, 1), children: [] });
  }
  return treeFromFlat(flat);
}
function treeFromFlat(flat: TocNode[]): TocNode[] { const roots: TocNode[] = []; const stack: TocNode[] = []; for (const node of flat) { while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop(); (stack[stack.length - 1]?.children ?? roots).push(node); stack.push(node); } return roots; }
function parseNcx(zip: AdmZip, file: string): TocNode[] {
  const entry = zip.getEntry(file); if (!entry) return [];
  const nav = xml.parse(entry.getData().toString('utf8')); const visit = (nodes: unknown, level: number): TocNode[] => array(nodes as never).flatMap((node) => { const n = node as Record<string, unknown>; const src = text((n.content as Record<string, string>)?.['@_src']); const current: TocNode | null = src ? { href: path.posix.normalize(path.posix.join(path.posix.dirname(file), src)), title: text((n.navLabel as Record<string, unknown>)?.text), level, children: [] } : null; const children = visit(n.navPoint, level + 1); if (current) current.children = children; return current ? [current] : children; });
  return visit(nav.ncx?.navMap?.navPoint, 1);
}
