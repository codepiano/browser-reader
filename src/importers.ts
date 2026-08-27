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
    chapters.push({ id, title: entry.title, level: entry.level, file, order: chapters.length, wordCount: countWords(markdown) });
  }
  return [{ id: workId, title: titleFromPath(displayName), chapters, source: 'markdown' }];
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
  for (const [index, idref] of spine.entries()) {
    const item = manifest[idref]; if (!item?.['@_href']) continue;
    const sourcePath = path.posix.normalize(path.posix.join(base, item['@_href'].split('#')[0]));
    const entry = zip.getEntry(sourcePath); if (!entry) continue;
    const raw = entry.getData().toString('utf8');
    const markdown = turndown.turndown(raw).trim();
    if (!markdown) continue;
    const tocItem = toc.find((candidate) => path.posix.normalize(candidate.href.split('#')[0]) === sourcePath);
    const chapterTitle = tocItem?.title || firstHeading(markdown) || `Chapter ${index + 1}`;
    const id = `${String(index + 1).padStart(3, '0')}-${slug(chapterTitle)}`;
    const file = `works/${workId}/chapters/${id}.md`;
    const target = inside(destination, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, markdown, 'utf8');
    chapters.push({ id, title: chapterTitle, level: tocItem?.level ?? 1, file, order: chapters.length, wordCount: countWords(markdown) });
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
