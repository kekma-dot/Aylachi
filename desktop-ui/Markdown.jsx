import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function MermaidDiagram({ code }) {
  const [result, setResult] = React.useState({ svg: '', error: '' });
  const id = `mermaid-${React.useId().replace(/:/g, '')}`;
  React.useEffect(() => {
    let active = true;
    setResult({ svg: '', error: '' });
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
      return mermaid.render(id, code);
    }).then(value => { if (active) setResult({ svg: value.svg, error: '' }); })
      .catch(() => { if (active) setResult({ svg: '', error: 'Mermaid diagram could not be rendered.' }); });
    return () => { active = false; };
  }, [code, id]);
  if (result.error) return <p className="error" role="alert">{result.error}</p>;
  if (!result.svg) return <pre className="mermaid-loading"><code>{code}</code></pre>;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: result.svg }} />;
}

function CodeBlock({ children, mermaid = false }) {
  const [label, setLabel] = React.useState('Copy');
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const code = React.Children.toArray(children)[0];
  const text = String(code?.props?.children ?? '').replace(/\n$/, '');
  if (mermaid && /language-mermaid/.test(code?.props?.className ?? '')) return <MermaidDiagram code={text} />;

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(text);
      setLabel('Copied');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setLabel('Copy'), 1500);
    } catch { setLabel('Copy failed'); }
  }

  return <div className="code-block"><button type="button" className="code-copy" onClick={copy}>{label}</button><pre>{children}</pre></div>;
}

export function Markdown({ text, mermaid = false }) {
  return <div className="markdown-body"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    components={{
      pre: props => <CodeBlock {...props} mermaid={mermaid} />,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    }}
  >{text}</ReactMarkdown></div>;
}
