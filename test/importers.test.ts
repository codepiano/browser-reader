import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { importEpub, importMarkdownDirectory } from '../src/importers.js';
import { inside, safeRelative } from '../src/safety.js';

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'temporary-reader-test-')); }

test('rejects paths that escape a session root', () => {
  assert.throws(() => safeRelative('../secret.md'), /Unsafe path/);
  assert.throws(() => inside('/tmp/session', '../../secret'), /Unsafe path/);
});

test('imports SUMMARY.md in declared order and keeps independent markdown files', async () => {
  const root = await tempDir(); const output = await tempDir();
  await fs.mkdir(path.join(root, 'chapters'));
  await fs.writeFile(path.join(root, 'SUMMARY.md'), '# Contents\n- [Second](chapters/second.md)\n- [First](chapters/first.md)\n');
  await fs.writeFile(path.join(root, 'chapters/first.md'), '# First\n\nHello.');
  await fs.writeFile(path.join(root, 'chapters/second.md'), '# Second\n\nWorld.');
  const works = await importMarkdownDirectory(root, 'my-book', output);
  assert.equal(works[0].chapters[0].title, 'Second');
  assert.equal(works[0].chapters[1].title, 'First');
  assert.match(await fs.readFile(path.join(output, works[0].chapters[0].file), 'utf8'), /World/);
});

test('honours GitBook root and structure.summary configuration safely', async () => {
  const root = await tempDir(); const output = await tempDir();
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, '.gitbook.yaml'), 'root: ./docs\nstructure:\n  readme: INTRO.md\n  summary: SUMMARY.md\n');
  await fs.writeFile(path.join(root, 'docs', 'SUMMARY.md'), '- [Configured](configured.md)\n');
  await fs.writeFile(path.join(root, 'docs', 'configured.md'), '# Configured\n\nFrom configured root.');
  await fs.writeFile(path.join(root, 'outside.md'), '# Should not be imported');
  const works = await importMarkdownDirectory(root, 'configured-book', output);
  assert.deepEqual(works[0].chapters.map((chapter) => chapter.title), ['Configured']);
  assert.match(await fs.readFile(path.join(output, works[0].chapters[0].file), 'utf8'), /configured root/i);
});

test('copies referenced Markdown images into controlled assets', async () => {
  const root = await tempDir(); const output = await tempDir(); const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await fs.writeFile(path.join(root, 'chapter.md'), '# Image\n\n![cover](cover.jpg)');
  await fs.writeFile(path.join(root, 'cover.jpg'), bytes);
  const works = await importMarkdownDirectory(root, 'image-book', output);
  assert.equal(works[0].chapters[0].resourceBase, '.');
  assert.deepEqual(await fs.readFile(path.join(output, 'assets', 'cover.jpg')), bytes);
});

test('resolves nested Markdown image references without escaping content root', async () => {
  const root = await tempDir(); const output = await tempDir(); const bytes = Buffer.from('nested-image');
  await fs.mkdir(path.join(root, 'chapters')); await fs.mkdir(path.join(root, 'images'));
  await fs.writeFile(path.join(root, 'chapters', 'a.md'), '# A\n\n![nested](../images/a.jpg)');
  await fs.writeFile(path.join(root, 'images', 'a.jpg'), bytes);
  const works = await importMarkdownDirectory(root, 'nested-book', output);
  assert.equal(works[0].chapters[0].resourceBase, 'chapters');
  assert.deepEqual(await fs.readFile(path.join(output, 'assets', 'images', 'a.jpg')), bytes);
});

test('imports a minimal reflowable EPUB spine and navigation title', async () => {
  const root = await tempDir(); const file = path.join(root, 'book.epub'); const output = await tempDir();
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/package.opf', Buffer.from('<package><metadata><dc:title>Test Book</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from('<nav><ol><li><a href="c1.xhtml">Opening</a></li></ol></nav>'));
  zip.addFile('OEBPS/c1.xhtml', Buffer.from('<html><head><title>Source metadata</title></head><body><h1>Ignored title</h1><p>Readable <em>text</em>.</p><script>alert(1)</script></body></html>'));
  zip.writeZip(file);
  const works = await importEpub(file, output, 'book.epub');
  assert.equal(works[0].title, 'Test Book');
  assert.equal(works[0].chapters[0].title, 'Opening');
  const markdown = await fs.readFile(path.join(output, works[0].chapters[0].file), 'utf8');
  assert.match(markdown, /Readable/);
  assert.doesNotMatch(markdown, /Source metadata/);
  assert.equal(works[0].chapters[0].sourceTitle, 'Source metadata');
});

test('uses a meaningful XHTML title only as a chapter-title fallback', async () => {
  const root = await tempDir(); const file = path.join(root, 'title.epub'); const output = await tempDir(); const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/package.opf', Buffer.from('<package><metadata><dc:title>Title Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'));
  zip.addFile('OEBPS/c1.xhtml', Buffer.from('<html><head><title>Meaningful chapter name</title></head><body><p>Text only.</p></body></html>')); zip.writeZip(file);
  const works = await importEpub(file, output, 'title.epub');
  assert.equal(works[0].chapters[0].title, 'Meaningful chapter name');
  assert.equal(works[0].chapters[0].sourceTitle, 'Meaningful chapter name');
  assert.match(await fs.readFile(path.join(output, works[0].chapters[0].file), 'utf8'), /^Text only\.$/);
});

test('extracts manifest images from EPUB with the correct bytes', async () => {
  const root = await tempDir(); const file = path.join(root, 'image.epub'); const output = await tempDir(); const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const zip = new AdmZip(); zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/package.opf', Buffer.from('<package><metadata><dc:title>Image Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="images/cover.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="c1"/></spine></package>'));
  zip.addFile('OEBPS/c1.xhtml', Buffer.from('<html><body><h1>Chapter</h1><p><img src="images/cover.jpg" alt="Cover"></p></body></html>'));
  zip.addFile('OEBPS/images/cover.jpg', bytes); zip.writeZip(file);
  const works = await importEpub(file, output, 'image.epub');
  assert.equal(works[0].chapters[0].resourceBase, 'OEBPS');
  assert.deepEqual(await fs.readFile(path.join(output, 'assets', 'OEBPS', 'images', 'cover.jpg')), bytes);
});

test('splits EPUB collection into top-level navigation works', async () => {
  const root = await tempDir(); const file = path.join(root, 'collection.epub'); const output = await tempDir();
  const zip = new AdmZip(); zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>'));
  zip.addFile('OEBPS/package.opf', Buffer.from('<package><metadata><dc:title>Collection</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav"/><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/><item id="c3" href="c3.xhtml"/><item id="c4" href="c4.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/><itemref idref="c4"/></spine></package>'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from('<nav><ol><li><a href="part-one.xhtml">Part One</a><ol><li><a href="c1.xhtml">One A</a></li><li><a href="c2.xhtml">One B</a></li></ol></li><li><a href="part-two.xhtml">Part Two</a><ol><li><a href="c3.xhtml">Two A</a></li><li><a href="c4.xhtml">Two B</a></li></ol></li></ol></nav>'));
  for (const [index, name] of ['One A', 'One B', 'Two A', 'Two B'].entries()) zip.addFile(`OEBPS/c${index + 1}.xhtml`, Buffer.from(`<html><body><h1>${name}</h1><p>Readable ${name}.</p></body></html>`));
  zip.writeZip(file);
  const works = await importEpub(file, output, 'collection.epub');
  assert.deepEqual(works.map((work) => work.title), ['Part One', 'Part Two']);
  assert.deepEqual(works.map((work) => work.chapters.length), [2, 2]);
});
