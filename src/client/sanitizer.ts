import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'mark', 'ol',
  'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
];
const ALLOWED_ATTR = ['alt', 'class', 'colspan', 'height', 'href', 'lang', 'loading', 'rel', 'rowspan', 'src', 'start', 'target', 'title', 'width'];

export function sanitizeRenderedHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'form', 'audio', 'video'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
    ADD_ATTR: [],
    RETURN_TRUSTED_TYPE: false
  });
}
