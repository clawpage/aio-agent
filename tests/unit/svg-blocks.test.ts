import { describe, expect, it } from "vitest";
import { looksLikeSvg } from "../../src/common/svg.js";
import { SVG_MAX_CHARS, splitSvgBlocks } from "../../src/ui/src/svgBlocks.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

describe("looksLikeSvg", () => {
  it("accepts an SVG root after a BOM, XML declaration, comments and doctype", () => {
    expect(looksLikeSvg(SVG)).toBe(true);
    expect(looksLikeSvg(`﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`)).toBe(true);
    expect(looksLikeSvg("  <SVG width='1'/>")).toBe(true);
  });

  it("refuses other markup and text that merely mentions svg", () => {
    expect(looksLikeSvg("<html><body><svg></svg></body></html>")).toBe(false);
    expect(looksLikeSvg("<svgfoo/>")).toBe(false);
    expect(looksLikeSvg("draw an <svg> please")).toBe(false);
    expect(looksLikeSvg("")).toBe(false);
  });
});

describe("splitSvgBlocks", () => {
  it("draws ```svg blocks in place and leaves the prose around them", () => {
    const parts = splitSvgBlocks(`这是图：\n\n\`\`\`svg\n${SVG}\n\`\`\`\n\n就这样。`);
    expect(parts).toEqual([
      { kind: "text", text: "这是图：\n\n" },
      { kind: "svg", code: SVG },
      { kind: "text", text: "\n\n就这样。" },
    ]);
  });

  it("keeps a block that is not an SVG, or too large, as an ordinary code block", () => {
    const notSvg = "```svg\n<div>not a picture</div>\n```";
    expect(splitSvgBlocks(notSvg)).toEqual([{ kind: "text", text: notSvg }]);
    const huge = `\`\`\`svg\n<svg>${"x".repeat(SVG_MAX_CHARS)}</svg>\n\`\`\``;
    expect(splitSvgBlocks(huge)).toEqual([{ kind: "text", text: huge }]);
    const xml = `\`\`\`xml\n${SVG}\n\`\`\``;
    expect(splitSvgBlocks(xml)).toEqual([{ kind: "text", text: xml }]);
  });
});
