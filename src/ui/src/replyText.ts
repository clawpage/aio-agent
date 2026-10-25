import { Marked, type Token, type Tokens } from "marked";
import { cjkStrong } from "./markdownStrong";
import { splitMessageParts } from "./messageParts";
import { workspaceFilePathFromHref } from "./sandboxLink";
import type { Product } from "./productBlocks";

/**
 * A reply as plain text, for the 复制 button: what a person would paste into a
 * chat or a note. Markdown marks go, a web link keeps its address, a workspace
 * file link keeps only its words, a table becomes tab-separated rows, and the
 * cards that only make sense on screen (answers to tap, forms, charts, pictures,
 * diagrams, cameras) are left out.
 *
 * Its own Marked instance: the global one carries Markdown.tsx's HTML renderers.
 * Only the lexer is used here, with the same CJK bold rule as the rendered reply.
 */
const lexer = new Marked({ gfm: true, breaks: true }).use({ extensions: [cjkStrong] });

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? []).map(inlineToken).join("");
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return "tokens" in token && token.tokens?.length ? inline(token.tokens) : token.text;
    case "escape":
    case "codespan":
      return token.text;
    case "strong":
    case "em":
    case "del":
      return inline(token.tokens);
    case "br":
      return "\n";
    case "link": {
      const { href } = token as Tokens.Link;
      const label = inline(token.tokens);
      const file = workspaceFilePathFromHref(href);
      if (file) return label || basename(file);
      if (/^https?:\/\//i.test(href) && label && label !== href) return `${label} (${href})`;
      return label || href;
    }
    case "image": {
      const { href, text } = token as Tokens.Image;
      const file = workspaceFilePathFromHref(href);
      return text || (file ? basename(file) : "");
    }
    case "html":
      return stripTags(token.text);
    default:
      return "tokens" in token && token.tokens?.length ? inline(token.tokens) : "text" in token && typeof token.text === "string" ? token.text : "";
  }
}

const indent = (text: string) => text.replace(/\n/g, "\n  ");

function block(token: Token): string {
  switch (token.type) {
    case "heading":
    case "paragraph":
    case "text":
      return "tokens" in token && token.tokens?.length ? inline(token.tokens) : token.text;
    case "list": {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      return list.items.map((item, i) => {
        const marker = list.ordered ? `${start + i}. ` : "- ";
        const box = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
        const body = item.tokens.map(block).filter(Boolean).join("\n");
        return marker + box + indent(body);
      }).join("\n");
    }
    case "blockquote":
      return blocks((token as Tokens.Blockquote).tokens);
    case "code":
      return (token as Tokens.Code).text;
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]) => cells.map((cell) => inline(cell.tokens)).join("\t");
      return [row(table.header), ...table.rows.map(row)].join("\n");
    }
    case "html":
      return stripTags(token.text).trim();
    case "hr":
    case "space":
    case "def":
    case "checkbox":
      return "";
    default:
      return "tokens" in token && token.tokens?.length ? inline(token.tokens) : "";
  }
}

function blocks(tokens: Token[]): string {
  return tokens.map(block).filter(Boolean).join("\n\n");
}

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]!);
}

function product(item: Product): string {
  return [item.name, item.subtitle, item.price, item.text, ...item.points.map((p) => `- ${p}`), item.url].filter((line): line is string => !!line).join("\n");
}

export function replyPlainText(source: string): string {
  const pieces = splitMessageParts(source).map((part) => {
    switch (part.kind) {
      case "text":
        return decode(blocks(lexer.lexer(part.text)));
      case "products":
        return part.items.map(product).join("\n\n");
      case "map":
        return [part.place.name, part.place.address].filter(Boolean).join("\n");
      case "ask":
        return part.question;
      default:
        return "";
    }
  });
  return pieces
    .filter((piece) => piece.trim())
    .join("\n\n")
    .replace(/ +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
