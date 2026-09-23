import { useCallback, useMemo, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { isSandboxLink } from "../sandboxLink";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Markdown is rendered with `marked`, then sanitised with DOMPurify (the
 * sanitizer is kept: the click handler is only a convenience, never the security
 * boundary). Absolute http/https links are intercepted so they open as a real
 * sandbox Chromium tab through the authenticated API instead of a host browser
 * tab; the server still re-validates scheme and credentials.
 *
 * Every other href (a relative path, a fragment, `mailto:`, another scheme) is
 * never navigable: the sanitizer drops the href, and the click handler makes any
 * remaining anchor inert. The console must not hand a link to a host program
 * (for example the host mail client); such content stays selectable text.
 */
export function Markdown({ source, onOpenLink }: { source: string; onOpenLink?: (url: string) => void }) {
  const html = useMemo(() => {
    const rendered = marked.parse(source ?? "", { async: false }) as string;
    const clean = DOMPurify.sanitize(rendered, {
      // Only web URLs survive sanitisation; everything else loses its href.
      ALLOWED_URI_REGEXP: /^(?:https?):/i,
      ADD_ATTR: ["target", "rel"],
    });
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }, [source]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (onOpenLink && isSandboxLink(href)) {
        // Always intercept http/https: even a modified/ctrl-click goes to the
        // sandbox browser rather than the host.
        event.preventDefault();
        onOpenLink(href);
        return;
      }
      // Never let any other href navigate the host page, or trigger a host
      // program such as a mail client.
      event.preventDefault();
    },
    [onOpenLink],
  );

  // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
