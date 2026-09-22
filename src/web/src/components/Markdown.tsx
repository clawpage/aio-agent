import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Markdown is rendered with `marked`, then sanitised with DOMPurify. Links are
 * forced to open in a new tab with rel="noopener noreferrer".
 */
export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(source ?? "", { async: false }) as string;
    const clean = DOMPurify.sanitize(rendered, {
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
      ADD_ATTR: ["target", "rel"],
    });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [source]);

  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
