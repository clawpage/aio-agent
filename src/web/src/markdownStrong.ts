import type { TokenizerAndRendererExtension } from "marked";

/**
 * `**原因：**报道` has to come out bold. CommonMark only lets a `**` close when
 * it is "right-flanking": a marker after punctuation must be followed by a space
 * or more punctuation. Chinese puts full-width punctuation right before the
 * closing marker and no space after it (and quotes right inside the opening
 * one), so those pairs stay as raw asterisks. This takes a `**…**` pair whose
 * content neither starts nor ends with a space before the stock rules look at
 * it; `***`, escapes and code spans still go the standard way.
 */
export const cjkStrong: TokenizerAndRendererExtension = {
  name: "cjkStrong",
  level: "inline",
  start(src) {
    const index = src.indexOf("**");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\*\*(?![\s*])([\s\S]*?[^\s\\*])\*\*(?!\*)/.exec(src);
    if (!match) return undefined;
    return { type: "strong", raw: match[0], text: match[1]!, tokens: this.lexer.inlineTokens(match[1]!) };
  },
};
