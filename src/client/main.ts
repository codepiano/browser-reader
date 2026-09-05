import { marked } from 'marked';
import { sanitizeRenderedHtml } from './sanitizer.js';
import { applyReaderFont, BUILTIN_FONTS, deleteUploadedFont, loadReaderFonts, saveUploadedFont, setActiveFont, ReaderFont } from './fonts.js';
import './style.css';

type TranscriptSegment = { speakerId?: string; speakerName?: string; role?: string; text: string };
type Chapter = { id: string; title: string; level: number; order: number; wordCount: number; contentType?: 'markdown' | 'transcript'; transcript?: TranscriptSegment[] };
type Work = { id: string; title: string; chapters: Chapter[]; source: string };
type ReadingLocation = { chapter: number; scrollRatio: number };
type Session = { id: string; title: string; sourceName: string; works: Work[]; selectedWorkId?: string; currentChapter?: number; locations?: Record<string, ReadingLocation> };
const app = document.querySelector<HTMLDivElement>('#app')!;
let session: Session | null = null;
let readerFonts: ReaderFont[] = [...BUILTIN_FONTS];
let activeFontId = 'system-serif';
let chapterIndex = 0;
let workId = '';
let tocOpen = false;
let progressSaveTimer: ReturnType<typeof setTimeout> | undefined;
const prefs = { size: Number(localStorage.getItem('reader-size') || 19), leading: Number(localStorage.getItem('reader-leading') || 1.85), width: Number(localStorage.getItem('reader-width') || 720), theme: localStorage.getItem('reader-theme') || 'paper' };

function esc(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] || char)); }
function renderMarkdown(source: string, resourceBase = '', sessionId = '') {
  const html = marked.parse(source, { gfm: true, breaks: false }) as string;
  const safe = sanitizeRenderedHtml(html);
  const template = document.createElement('template'); template.innerHTML = safe;
  template.content.querySelectorAll('h1').forEach((heading) => {
    const replacement = document.createElement('h2');
    replacement.replaceChildren(...Array.from(heading.childNodes).map((node) => node.cloneNode(true)));
    for (const attribute of Array.from(heading.attributes)) replacement.setAttribute(attribute.name, attribute.value);
    heading.replaceWith(replacement);
  });
  template.content.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const source = image.getAttribute('src') || '';
    if (!source || /^(?:https?:|data:|file:|javascript:|blob:)/i.test(source)) { image.removeAttribute('src'); return; }
    try {
      const resolved = new URL(source, `https://local-reader.invalid/${resourceBase ? `${resourceBase.replace(/^\/+|\/+$/g, '')}/` : ''}`);
      if (resolved.origin !== 'https://local-reader.invalid' || !sessionId) { image.removeAttribute('src'); return; }
      const parts = resolved.pathname.split('/').filter(Boolean);
      image.src = `/api/sessions/${encodeURIComponent(sessionId)}/assets/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
    } catch { image.removeAttribute('src'); }
  });
  return template.innerHTML;
}
function currentWork() { return session?.works.find((work) => work.id === workId) || session?.works[0]; }
async function api<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data as T; }
function currentScrollRatio() { const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight); return max === 0 ? 0 : Math.max(0, Math.min(1, window.scrollY / max)); }
function rememberProgress() { if (!session || !workId) return null; const updatedAt = new Date().toISOString(); const location = { chapter: chapterIndex, scrollRatio: currentScrollRatio(), updatedAt }; session.locations = { ...(session.locations ?? {}), [workId]: location }; session.currentChapter = chapterIndex; return { workId, chapter: chapterIndex, scrollRatio: location.scrollRatio }; }
function saveProgress(keepalive = false) { const payload = rememberProgress(); if (!session || !payload) return; const body = JSON.stringify(payload); if (keepalive && navigator.sendBeacon) { navigator.sendBeacon(`/api/sessions/${encodeURIComponent(session.id)}/progress`, new Blob([body], { type: 'application/json' })); return; } void fetch(`/api/sessions/${encodeURIComponent(session.id)}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }); }
function scheduleProgressSave() { if (progressSaveTimer) clearTimeout(progressSaveTimer); progressSaveTimer = setTimeout(() => saveProgress(), 600); }
function restoreScroll(ratio: number) { requestAnimationFrame(() => requestAnimationFrame(() => { const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight); window.scrollTo({ top: Math.max(0, Math.min(max, max * ratio)), behavior: 'auto' }); })); }

function shell(content: string) {
  app.innerHTML = `<div class="app-shell theme-${prefs.theme}"><header class="topbar"><div class="brand"><span class="brand-mark">◒</span><span>共读台</span></div>${session ? `<div class="session-name">${esc(session.title)}</div><button class="ghost" data-action="end">结束共读</button>` : ''}</header>${content}</div>`;
  applyPrefs();
}
function fontSettingsMarkup() {
  const options = readerFonts.map((font) => `<option value="${esc(font.id)}" ${font.id === activeFontId ? 'selected' : ''}>${esc(font.label)}</option>`).join('');
  const selected = readerFonts.find((font) => font.id === activeFontId);
  return `<label>字体<select id="font-select">${options}</select></label><div class="font-actions"><button class="secondary" type="button" data-action="upload-font">上传字体</button>${selected?.kind === 'uploaded' ? '<button class="text-button" type="button" data-action="delete-font">删除</button>' : ''}<input id="font-input" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" hidden/></div><p id="font-error" class="font-error" role="status"></p>`;
}
function importView(error = '') {
  shell(`<main class="landing"><div class="eyebrow">ONE-TIME READING WORKSPACE</div><h1>让一本书，<em>安静地进入</em><br/>你的共读。</h1><p class="lede">导入一本 EPUB、Markdown 或音频转写文本，整理结构后只显示当前章节。页面保持干净，适合与你正在使用的 AI 浏览器插件一起阅读。</p><div class="dropzone" id="dropzone"><div class="drop-icon">↥</div><strong>把内容拖到这里</strong><span>支持无 DRM EPUB、Markdown 文件或多人对谈转写文本</span><div class="import-actions"><button class="primary" data-action="epub">选择 EPUB</button><button class="secondary" data-action="file">选择 Markdown</button><button class="secondary" data-action="transcript">选择转写文本</button><button class="secondary" data-action="folder">选择 Markdown 目录</button></div><input id="epub-input" type="file" accept=".epub,application/epub+zip" hidden/><input id="file-input" type="file" accept=".md,text/markdown" hidden/><input id="transcript-input" type="file" accept=".txt,text/plain" hidden/><input id="folder-input" type="file" webkitdirectory multiple hidden/></div>${error ? `<div class="error">${esc(error)}</div>` : ''}<div class="privacy"><span>⌁</span> 内容只在本机临时处理，结束后可一键删除</div></main>`); setupEvents();
}
function inspectView() {
  if (session) sessionStorage.setItem('temporary-reader-session', session.id);
  const works = session!.works;
  shell(`<main class="inspect"><div class="eyebrow">STRUCTURE CHECK</div><h1>这本书准备好了。</h1><p class="lede">${esc(session!.sourceName)} · ${works.reduce((sum, work) => sum + work.chapters.length, 0)} 个章节</p><div class="inspect-card">${works.length > 1 ? `<div class="card-label">检测到合集，请选择本次要读的范围</div>` : `<div class="card-label">阅读范围</div>`}<div class="work-list">${works.map((work) => `<button class="work-option ${work.id === workId ? 'selected' : ''}" data-work="${esc(work.id)}"><span class="radio"></span><span class="work-info"><strong>${esc(work.title)}</strong><small>${work.chapters.length} 章 · ${Math.round(work.chapters.reduce((n, c) => n + c.wordCount, 0) / 1000)}k 字</small></span><span class="arrow">→</span></button>`).join('')}</div><button class="primary wide" data-action="start">开始共读 <span>→</span></button></div><button class="back-link" data-action="discard">← 放弃并删除</button></main>`); setupEvents();
}
function readerView() {
  if (session) sessionStorage.setItem('temporary-reader-session', session.id);
  const work = currentWork()!; const chapter = work.chapters[chapterIndex];
  shell(`<div class="reader-layout">${tocOpen ? `<aside class="toc open" id="toc"><div class="toc-head"><div><span class="eyebrow">CONTENTS</span><h2>${esc(work.title)}</h2></div><button class="icon-button" data-action="toc">×</button></div><nav>${work.chapters.map((item, i) => `<button class="toc-item ${i === chapterIndex ? 'active' : ''}" data-chapter="${i}"><span>${String(i + 1).padStart(2, '0')}</span>${esc(item.title)}</button>`).join('')}</nav></aside>` : ''}<main class="reading"><div class="reading-toolbar"><div class="toolbar-navigation">${session!.works.length > 1 ? '<button class="toolbar-button work-picker" data-action="works">← <span>返回书本选择</span></button>' : ''}<button class="toolbar-button" data-action="toc">☰ <span>目录</span></button></div><div class="breadcrumb">${esc(work.title)} <span>/</span> ${String(chapterIndex + 1).padStart(2, '0')} / ${work.chapters.length}</div><div class="toolbar-actions"><button class="toolbar-button" data-action="settings">Aa</button></div></div><article data-session-id="${session!.id}" data-work-id="${work.id}" data-chapter-id="${chapter.id}"><header class="chapter-head"><div class="chapter-kicker">${String(chapterIndex + 1).padStart(2, '0')} · ${esc(work.title)}</div><h1>${esc(chapter.title)}</h1><div class="chapter-meta">${chapter.wordCount.toLocaleString()} 字</div></header><section class="reader-content"><p class="chapter-loading" aria-live="polite">正在载入章节…</p></section><footer class="chapter-nav"><button class="nav-button" data-action="previous" ${chapterIndex === 0 ? 'disabled' : ''}>← <span>上一章</span></button><span>${chapterIndex + 1} / ${work.chapters.length}</span><button class="nav-button" data-action="next" ${chapterIndex >= work.chapters.length - 1 ? 'disabled' : ''}><span>下一章</span> →</button></footer></article></main></div><div class="settings-popover" id="settings">${fontSettingsMarkup()}<label>字号 <input type="range" min="15" max="25" value="${prefs.size}" data-pref="size"/></label><label>行距 <input type="range" min="1.4" max="2.3" step=".05" value="${prefs.leading}" data-pref="leading"/></label><label>宽度 <input type="range" min="580" max="900" step="10" value="${prefs.width}" data-pref="width"/></label><div class="theme-row"><button data-theme="paper">纸张</button><button data-theme="night">夜读</button></div></div>`);
  loadChapter(); setupEvents();
}
function renderTranscript(segments: TranscriptSegment[]) { return `<div class="transcript" aria-label="对谈转写">${segments.map((segment, index) => `<section class="transcript-turn ${segment.speakerId ? 'identified' : 'unidentified'}" style="--speaker-index:${index % 6}"><header>${segment.speakerName ? `<strong>${esc(segment.speakerName)}</strong><span>${esc(segment.role || '说话人')}</span>` : '<strong>未标注说话人</strong><span>转写文本</span>'}</header><div>${segment.text.split(/\n+/).map((line) => `<p>${esc(line)}</p>`).join('')}</div></section>`).join('')}</div>`; }
async function loadChapter() { if (!session) return; const requestedChapter = chapterIndex; const requestedWork = workId; const section = document.querySelector<HTMLElement>('.reader-content'); if (section) section.innerHTML = '<p class="chapter-loading" aria-live="polite">正在载入章节…</p>'; try { const data = await api<{ markdown: string; sessionId: string; chapter: { resourceBase?: string; contentType?: string; transcript?: TranscriptSegment[] }; transcript?: TranscriptSegment[]; warning?: string }>(`/api/sessions/${session.id}/chapter/${requestedChapter}?work=${encodeURIComponent(requestedWork)}`); if (requestedChapter !== chapterIndex || requestedWork !== workId || !document.querySelector('article')) return; if (section) { section.innerHTML = data.chapter.contentType === 'transcript' && data.transcript ? renderTranscript(data.transcript) : renderMarkdown(data.markdown, data.chapter.resourceBase, data.sessionId); if (data.warning) section.insertAdjacentHTML('afterbegin', `<p class="compat-warning">${esc(data.warning)}</p>`); } const location = session.locations?.[requestedWork]; restoreScroll(location?.chapter === requestedChapter ? location.scrollRatio : 0); } catch (error) { if (requestedChapter === chapterIndex) importView(error instanceof Error ? error.message : '章节加载失败'); } }
function applyPrefs() { const root = document.documentElement; root.style.setProperty('--reader-size', `${prefs.size}px`); root.style.setProperty('--reader-leading', `${prefs.leading}`); root.style.setProperty('--reader-width', `${prefs.width}px`); }
function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return element?.matches('input, textarea, select, [contenteditable="true"]') || element?.closest('[contenteditable="true"]');
}
function isTranscriptFile(file: File): boolean { return /\.txt$/i.test(file.name) || file.type === 'text/plain'; }
function handleReaderKeydown(event: KeyboardEvent) {
  if (!session || !document.querySelector('.reading') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return;
  const work = currentWork();
  if (!work) return;
  if (event.key === 'ArrowLeft' && chapterIndex > 0) {
    event.preventDefault();
    saveProgress();
    chapterIndex--;
    tocOpen = false;
    readerView();
  } else if (event.key === 'ArrowRight' && chapterIndex < work.chapters.length - 1) {
    event.preventDefault();
    saveProgress();
    chapterIndex++;
    tocOpen = false;
    readerView();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    window.scrollBy({ top: direction * Math.max(240, Math.round(window.innerHeight * 0.86)), behavior: 'smooth' });
  }
}
function setupEvents() {
  app.onclick = async (event) => { const target = event.target as HTMLElement; const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'epub') document.querySelector<HTMLInputElement>('#epub-input')?.click();
    if (action === 'folder') document.querySelector<HTMLInputElement>('#folder-input')?.click();
    if (action === 'file') document.querySelector<HTMLInputElement>('#file-input')?.click();
    if (action === 'transcript') document.querySelector<HTMLInputElement>('#transcript-input')?.click();
    if (action === 'discard') { if (session) await deleteSession(); else importView(); }
    if (action === 'start') { const selected = document.querySelector<HTMLElement>('.work-option.selected')?.dataset.work; workId = selected || session!.works[0].id; chapterIndex = session!.locations?.[workId]?.chapter ?? 0; await api(`/api/sessions/${session!.id}/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workId, chapter: chapterIndex }) }); readerView(); }
    if (action === 'works') { saveProgress(); tocOpen = false; inspectView(); }
    if (action === 'toc') { saveProgress(); tocOpen = !tocOpen; readerView(); }
    if (action === 'settings') document.querySelector('#settings')?.classList.toggle('visible');
    if (action === 'upload-font') document.querySelector<HTMLInputElement>('#font-input')?.click();
    if (action === 'delete-font') {
      const font = readerFonts.find((candidate) => candidate.id === activeFontId);
      if (font?.kind === 'uploaded' && confirm(`删除字体“${font.label}”？`)) {
        try { await deleteUploadedFont(font.id); readerFonts = readerFonts.filter((candidate) => candidate.id !== font.id); activeFontId = 'system-serif'; await setActiveFont(activeFontId); await applyReaderFont(BUILTIN_FONTS[0]); readerView(); } catch (error) { const node = document.querySelector('#font-error'); if (node) node.textContent = error instanceof Error ? error.message : '删除字体失败'; }
      }
    }
    if (action === 'previous' && chapterIndex > 0) { saveProgress(); chapterIndex--; readerView(); }
    if (action === 'next' && chapterIndex < currentWork()!.chapters.length - 1) { saveProgress(); chapterIndex++; readerView(); }
    if (action === 'end') { if (confirm('结束这次共读并删除临时文件？此操作不可撤销。')) await deleteSession(); }
    const work = target.closest<HTMLElement>('[data-work]')?.dataset.work; if (work) { document.querySelectorAll('.work-option').forEach((node) => node.classList.toggle('selected', node.getAttribute('data-work') === work)); }
    const ch = target.closest<HTMLElement>('[data-chapter]')?.dataset.chapter; if (ch) { saveProgress(); chapterIndex = Number(ch); tocOpen = false; readerView(); }
    const theme = target.closest<HTMLElement>('[data-theme]')?.dataset.theme; if (theme) { saveProgress(); prefs.theme = theme; localStorage.setItem('reader-theme', theme); readerView(); }
  };
  app.oninput = (event) => { const input = event.target as HTMLInputElement; const key = input.dataset.pref as keyof typeof prefs; if (!key) return; prefs[key] = Number(input.value) as never; localStorage.setItem(`reader-${key}`, input.value); applyPrefs(); };
  app.onchange = async (event) => { const target = event.target as HTMLInputElement | HTMLSelectElement; if (target.id === 'font-select') { const font = readerFonts.find((candidate) => candidate.id === target.value); if (!font) return; try { await applyReaderFont(font); await setActiveFont(font.id); activeFontId = font.id; } catch (error) { const node = document.querySelector('#font-error'); if (node) node.textContent = error instanceof Error ? error.message : '字体加载失败'; } } };
  document.querySelector<HTMLInputElement>('#epub-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'epub'));
  document.querySelector<HTMLInputElement>('#folder-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'markdown'));
  document.querySelector<HTMLInputElement>('#file-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'markdown-file'));
  document.querySelector<HTMLInputElement>('#transcript-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'transcript-file'));
  document.querySelector<HTMLInputElement>('#font-input')?.addEventListener('change', async (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; try { const uploaded = await saveUploadedFont(file); await applyReaderFont(uploaded); await setActiveFont(uploaded.id); readerFonts.push(uploaded); activeFontId = uploaded.id; readerView(); document.querySelector('#settings')?.classList.add('visible'); } catch (error) { const node = document.querySelector('#font-error'); if (node) node.textContent = error instanceof Error ? error.message : '字体上传失败'; } });
  const dropzone = document.querySelector<HTMLElement>('#dropzone');
  dropzone?.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('drag'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone?.addEventListener('drop', (event) => { event.preventDefault(); dropzone.classList.remove('drag'); const files = event.dataTransfer?.files; const list = [...(files || [])]; const kind = list.some((file) => /\.epub$/i.test(file.name)) ? 'epub' : list.length === 1 && isTranscriptFile(list[0]) && !(list[0] as any).webkitRelativePath ? 'transcript-file' : list.length === 1 && /\.md$/i.test(list[0].name) && !(list[0] as any).webkitRelativePath ? 'markdown-file' : 'markdown'; importFiles(files, kind); });
}
async function importFiles(files: FileList | null | undefined, kind: string) { if (!files?.length) return; const body = new FormData(); body.append('kind', kind); [...files].forEach((file) => body.append('files', file, (file as any).webkitRelativePath || file.name)); app.innerHTML = `<main class="loading"><div class="loader"></div><p>正在整理书籍结构…</p></main>`; try { session = await api<Session>('/api/import', { method: 'POST', body }); workId = session.works[0]?.id || ''; inspectView(); } catch (error) { importView(error instanceof Error ? error.message : '导入失败'); setupEvents(); } }
async function deleteSession() { if (!session) return; await api(`/api/sessions/${session.id}`, { method: 'DELETE' }); sessionStorage.removeItem('temporary-reader-session'); session = null; chapterIndex = 0; importView(); setupEvents(); }
async function boot() { try { const catalog = await loadReaderFonts(); readerFonts = [...BUILTIN_FONTS, ...catalog.fonts]; activeFontId = catalog.activeFontId; const selected = readerFonts.find((font) => font.id === activeFontId) || BUILTIN_FONTS[0]; await applyReaderFont(selected); } catch { readerFonts = [...BUILTIN_FONTS]; activeFontId = 'system-serif'; await applyReaderFont(BUILTIN_FONTS[0]); } try { const id = sessionStorage.getItem('temporary-reader-session'); if (id) { session = await api<Session>(`/api/sessions/${id}`); workId = session.selectedWorkId || session.works[0]?.id || ''; const location = workId ? session.locations?.[workId] : undefined; chapterIndex = location?.chapter ?? session.currentChapter ?? 0; readerView(); setupEvents(); return; } } catch { sessionStorage.removeItem('temporary-reader-session'); } importView(); setupEvents(); }
boot();

document.addEventListener('keydown', handleReaderKeydown);
window.addEventListener('scroll', scheduleProgressSave, { passive: true });
window.addEventListener('pagehide', () => saveProgress(true));
