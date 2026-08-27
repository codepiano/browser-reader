import { marked } from 'marked';
import { sanitizeRenderedHtml } from './sanitizer.js';
import './style.css';

type Chapter = { id: string; title: string; level: number; order: number; wordCount: number };
type Work = { id: string; title: string; chapters: Chapter[]; source: string };
type Session = { id: string; title: string; sourceName: string; works: Work[]; selectedWorkId?: string; currentChapter?: number };
const app = document.querySelector<HTMLDivElement>('#app')!;
let session: Session | null = null;
let chapterIndex = 0;
let workId = '';
let tocOpen = false;
const prefs = { size: Number(localStorage.getItem('reader-size') || 19), leading: Number(localStorage.getItem('reader-leading') || 1.85), width: Number(localStorage.getItem('reader-width') || 720), theme: localStorage.getItem('reader-theme') || 'paper' };

function esc(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] || char)); }
function renderMarkdown(source: string, resourceBase = '', sessionId = '') {
  const html = marked.parse(source, { gfm: true, breaks: false }) as string;
  const safe = sanitizeRenderedHtml(html);
  const template = document.createElement('template'); template.innerHTML = safe;
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

function shell(content: string) {
  app.innerHTML = `<div class="app-shell theme-${prefs.theme}"><header class="topbar"><div class="brand"><span class="brand-mark">◒</span><span>共读台</span></div>${session ? `<div class="session-name">${esc(session.title)}</div><button class="ghost" data-action="end">结束共读</button>` : ''}</header>${content}</div>`;
  applyPrefs();
}
function importView(error = '') {
  shell(`<main class="landing"><div class="eyebrow">ONE-TIME READING WORKSPACE</div><h1>让一本书，<em>安静地进入</em><br/>你的共读。</h1><p class="lede">导入一本 EPUB 或 Markdown 书籍，整理结构后只显示当前章节。页面保持干净，适合与你正在使用的 AI 浏览器插件一起阅读。</p><div class="dropzone" id="dropzone"><div class="drop-icon">↥</div><strong>把书拖到这里</strong><span>支持无 DRM EPUB、GitBook / mdBook / Markdown 文件夹</span><div class="import-actions"><button class="primary" data-action="epub">选择 EPUB</button><button class="secondary" data-action="folder">选择 Markdown 目录</button></div><input id="epub-input" type="file" accept=".epub,application/epub+zip" hidden/><input id="folder-input" type="file" webkitdirectory multiple hidden/></div>${error ? `<div class="error">${esc(error)}</div>` : ''}<div class="privacy"><span>⌁</span> 内容只在本机临时处理，结束后可一键删除</div></main>`); setupEvents();
}
function inspectView() {
  if (session) sessionStorage.setItem('temporary-reader-session', session.id);
  const works = session!.works;
  shell(`<main class="inspect"><div class="eyebrow">STRUCTURE CHECK</div><h1>这本书准备好了。</h1><p class="lede">${esc(session!.sourceName)} · ${works.reduce((sum, work) => sum + work.chapters.length, 0)} 个章节</p><div class="inspect-card">${works.length > 1 ? `<div class="card-label">检测到合集，请选择本次要读的范围</div>` : `<div class="card-label">阅读范围</div>`}<div class="work-list">${works.map((work, i) => `<button class="work-option ${i === 0 ? 'selected' : ''}" data-work="${esc(work.id)}"><span class="radio"></span><span class="work-info"><strong>${esc(work.title)}</strong><small>${work.chapters.length} 章 · ${Math.round(work.chapters.reduce((n, c) => n + c.wordCount, 0) / 1000)}k 字</small></span><span class="arrow">→</span></button>`).join('')}</div><button class="primary wide" data-action="start">开始共读 <span>→</span></button></div><button class="back-link" data-action="discard">← 放弃并删除</button></main>`); setupEvents();
}
function readerView() {
  if (session) sessionStorage.setItem('temporary-reader-session', session.id);
  const work = currentWork()!; const chapter = work.chapters[chapterIndex];
  shell(`<div class="reader-layout">${tocOpen ? `<aside class="toc open" id="toc"><div class="toc-head"><div><span class="eyebrow">CONTENTS</span><h2>${esc(work.title)}</h2></div><button class="icon-button" data-action="toc">×</button></div><nav>${work.chapters.map((item, i) => `<button class="toc-item ${i === chapterIndex ? 'active' : ''}" data-chapter="${i}"><span>${String(i + 1).padStart(2, '0')}</span>${esc(item.title)}</button>`).join('')}</nav></aside>` : ''}<main class="reading"><div class="reading-toolbar"><button class="toolbar-button" data-action="toc">☰ <span>目录</span></button><div class="breadcrumb">${esc(work.title)} <span>/</span> ${String(chapterIndex + 1).padStart(2, '0')} / ${work.chapters.length}</div><div class="toolbar-actions"><button class="toolbar-button" data-action="settings">Aa</button></div></div><article data-session-id="${session!.id}" data-work-id="${work.id}" data-chapter-id="${chapter.id}"><header class="chapter-head"><div class="chapter-kicker">${String(chapterIndex + 1).padStart(2, '0')} · ${esc(work.title)}</div><h1>${esc(chapter.title)}</h1><div class="chapter-meta">${chapter.wordCount.toLocaleString()} 字</div></header><section class="reader-content"><p class="chapter-loading" aria-live="polite">正在载入章节…</p></section><footer class="chapter-nav"><button class="nav-button" data-action="previous" ${chapterIndex === 0 ? 'disabled' : ''}>← <span>上一章</span></button><span>${chapterIndex + 1} / ${work.chapters.length}</span><button class="nav-button" data-action="next" ${chapterIndex >= work.chapters.length - 1 ? 'disabled' : ''}><span>下一章</span> →</button></footer></article></main></div><div class="settings-popover" id="settings"><label>字号 <input type="range" min="15" max="25" value="${prefs.size}" data-pref="size"/></label><label>行距 <input type="range" min="1.4" max="2.3" step=".05" value="${prefs.leading}" data-pref="leading"/></label><label>宽度 <input type="range" min="580" max="900" step="10" value="${prefs.width}" data-pref="width"/></label><div class="theme-row"><button data-theme="paper">纸张</button><button data-theme="night">夜读</button></div></div>`);
  loadChapter(); setupEvents();
}
async function loadChapter() { if (!session) return; const requestedChapter = chapterIndex; const section = document.querySelector<HTMLElement>('.reader-content'); if (section) section.innerHTML = '<p class="chapter-loading" aria-live="polite">正在载入章节…</p>'; try { const data = await api<{ markdown: string; sessionId: string; chapter: { resourceBase?: string }; warning?: string }>(`/api/sessions/${session.id}/chapter/${requestedChapter}?work=${encodeURIComponent(workId)}`); if (requestedChapter !== chapterIndex || !document.querySelector('article')) return; if (section) { section.innerHTML = renderMarkdown(data.markdown, data.chapter.resourceBase, data.sessionId); if (data.warning) section.insertAdjacentHTML('afterbegin', `<p class="compat-warning">${esc(data.warning)}</p>`); } window.scrollTo({ top: 0 }); } catch (error) { if (requestedChapter === chapterIndex) importView(error instanceof Error ? error.message : '章节加载失败'); } }
function applyPrefs() { const root = document.documentElement; root.style.setProperty('--reader-size', `${prefs.size}px`); root.style.setProperty('--reader-leading', `${prefs.leading}`); root.style.setProperty('--reader-width', `${prefs.width}px`); }
function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return element?.matches('input, textarea, select, [contenteditable="true"]') || element?.closest('[contenteditable="true"]');
}
function handleReaderKeydown(event: KeyboardEvent) {
  if (!session || !document.querySelector('.reading') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return;
  const work = currentWork();
  if (!work) return;
  if (event.key === 'ArrowLeft' && chapterIndex > 0) {
    event.preventDefault();
    chapterIndex--;
    tocOpen = false;
    readerView();
  } else if (event.key === 'ArrowRight' && chapterIndex < work.chapters.length - 1) {
    event.preventDefault();
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
    if (action === 'discard') { if (session) await deleteSession(); else importView(); }
    if (action === 'start') { const selected = document.querySelector<HTMLElement>('.work-option.selected')?.dataset.work; workId = selected || session!.works[0].id; chapterIndex = 0; await api(`/api/sessions/${session!.id}/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workId }) }); readerView(); }
    if (action === 'toc') { tocOpen = !tocOpen; readerView(); }
    if (action === 'settings') document.querySelector('#settings')?.classList.toggle('visible');
    if (action === 'previous' && chapterIndex > 0) { chapterIndex--; readerView(); }
    if (action === 'next' && chapterIndex < currentWork()!.chapters.length - 1) { chapterIndex++; readerView(); }
    if (action === 'end') { if (confirm('结束这次共读并删除临时文件？此操作不可撤销。')) await deleteSession(); }
    const work = target.closest<HTMLElement>('[data-work]')?.dataset.work; if (work) { document.querySelectorAll('.work-option').forEach((node) => node.classList.toggle('selected', node.getAttribute('data-work') === work)); }
    const ch = target.closest<HTMLElement>('[data-chapter]')?.dataset.chapter; if (ch) { chapterIndex = Number(ch); tocOpen = false; readerView(); }
    const theme = target.closest<HTMLElement>('[data-theme]')?.dataset.theme; if (theme) { prefs.theme = theme; localStorage.setItem('reader-theme', theme); readerView(); }
  };
  app.oninput = (event) => { const input = event.target as HTMLInputElement; const key = input.dataset.pref as keyof typeof prefs; if (!key) return; prefs[key] = Number(input.value) as never; localStorage.setItem(`reader-${key}`, input.value); applyPrefs(); };
  document.querySelector<HTMLInputElement>('#epub-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'epub'));
  document.querySelector<HTMLInputElement>('#folder-input')?.addEventListener('change', (event) => importFiles((event.target as HTMLInputElement).files, 'markdown'));
  const dropzone = document.querySelector<HTMLElement>('#dropzone');
  dropzone?.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('drag'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone?.addEventListener('drop', (event) => { event.preventDefault(); dropzone.classList.remove('drag'); const files = event.dataTransfer?.files; importFiles(files, [...(files || [])].some((file) => /\.epub$/i.test(file.name)) ? 'epub' : 'markdown'); });
}
async function importFiles(files: FileList | null | undefined, kind: string) { if (!files?.length) return; const body = new FormData(); body.append('kind', kind); [...files].forEach((file) => body.append('files', file, (file as any).webkitRelativePath || file.name)); app.innerHTML = `<main class="loading"><div class="loader"></div><p>正在整理书籍结构…</p></main>`; try { session = await api<Session>('/api/import', { method: 'POST', body }); workId = session.works[0]?.id || ''; inspectView(); } catch (error) { importView(error instanceof Error ? error.message : '导入失败'); setupEvents(); } }
async function deleteSession() { if (!session) return; await api(`/api/sessions/${session.id}`, { method: 'DELETE' }); sessionStorage.removeItem('temporary-reader-session'); session = null; chapterIndex = 0; importView(); setupEvents(); }
async function boot() { try { const id = sessionStorage.getItem('temporary-reader-session'); if (id) { session = await api<Session>(`/api/sessions/${id}`); workId = session.selectedWorkId || session.works[0]?.id || ''; chapterIndex = session.currentChapter || 0; readerView(); setupEvents(); return; } } catch { sessionStorage.removeItem('temporary-reader-session'); } importView(); setupEvents(); }
boot();

document.addEventListener('keydown', handleReaderKeydown);
