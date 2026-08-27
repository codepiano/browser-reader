export type BuiltinFont = { id: string; label: string; family: string; kind: 'builtin' };
export type UploadedFont = { id: string; label: string; family: string; kind: 'uploaded'; format: string; fileName: string; bytes: number; createdAt: string };
export type ReaderFont = BuiltinFont | UploadedFont;
export type FontCatalog = { fonts: UploadedFont[]; activeFontId: string };

export const BUILTIN_FONTS: BuiltinFont[] = [
  { id: 'system-serif', label: '系统衬线', family: 'ui-serif, "Songti SC", "STSong", "Noto Serif CJK SC", serif', kind: 'builtin' },
  { id: 'system-sans', label: '系统无衬线', family: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif', kind: 'builtin' },
  { id: 'system-mono', label: '等宽字体', family: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, monospace', kind: 'builtin' }
];

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '字体服务请求失败');
  return data;
}

export async function loadReaderFonts(): Promise<FontCatalog> {
  return responseJson<FontCatalog>(await fetch('/api/fonts'));
}

export async function saveUploadedFont(file: File): Promise<UploadedFont> {
  const body = new FormData(); body.append('font', file, file.name);
  return responseJson<UploadedFont>(await fetch('/api/fonts', { method: 'POST', body }));
}

export async function deleteUploadedFont(id: string): Promise<void> {
  await responseJson(await fetch(`/api/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function setActiveFont(id: string): Promise<void> {
  await responseJson(await fetch('/api/fonts/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fontId: id }) }));
}

export function fontCssFamily(font: ReaderFont): string {
  return font.kind === 'builtin' ? font.family : `"${font.family}", ${BUILTIN_FONTS[0].family}`;
}

export async function applyReaderFont(font: ReaderFont): Promise<void> {
  document.documentElement.style.setProperty('--reader-font', fontCssFamily(font));
  const state = applyReaderFont as typeof applyReaderFont & { activeFace?: FontFace };
  if (state.activeFace) { document.fonts.delete(state.activeFace); delete state.activeFace; }
  if (font.kind === 'uploaded') {
    const face = new FontFace(font.family, `url("/api/fonts/${encodeURIComponent(font.id)}/file")`, { style: 'normal', weight: '400', display: 'swap' });
    document.fonts.add(face); await face.load(); state.activeFace = face;
  }
}
