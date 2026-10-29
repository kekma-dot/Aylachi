const text = (extension, mimeType) => ({
  validate(content) { if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 64 * 1024) throw Object.assign(new Error('INVALID_CONTENT'), { code: 'INVALID_CONTENT' }); },
  export({ title, content }) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'artifact';
    return { fileName: `${slug}.${extension}`, mimeType, content };
  },
});

export const builtinRenderers = Object.freeze({
  markdown: Object.freeze(text('md', 'text/markdown; charset=utf-8')),
  mermaid: Object.freeze(text('mmd', 'text/plain; charset=utf-8')),
  html: Object.freeze(text('html', 'text/html; charset=utf-8')),
});

// Scripts, storage and network are unavailable in the opaque sandbox. User markup cannot loosen this first CSP.
export function htmlPreviewDocument(content) {
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">' + content;
}
