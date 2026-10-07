import { describe, expect, it } from "vitest";
import { MERMAID_MAX_CHARS, splitMermaidBlocks } from "../../src/ui/src/mermaidBlocks.js";
import { sizedSvg } from "../../src/ui/src/components/MermaidCard.js";

const FLOW = 'flowchart TD\n  A["出发"] --> B{"签证办好了吗？"}\n  B -->|是| C["值机"]';

describe("splitMermaidBlocks", () => {
  it("draws ```mermaid blocks in place and leaves the prose around them", () => {
    expect(splitMermaidBlocks(`流程如下：\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n照着走就行。`)).toEqual([
      { kind: "text", text: "流程如下：\n\n" },
      { kind: "mermaid", code: FLOW },
      { kind: "text", text: "\n\n照着走就行。" },
    ]);
    expect(splitMermaidBlocks(`\`\`\`mermaid\n${FLOW}\n\`\`\`\n\`\`\`mermaid\n${FLOW}\n\`\`\``).filter((p) => p.kind === "mermaid")).toHaveLength(2);
  });

  it("leaves empty, oversized and other code blocks as text", () => {
    for (const source of ["```mermaid\n   \n```", `\`\`\`mermaid\n${"A-->B\n".repeat(MERMAID_MAX_CHARS / 5)}\n\`\`\``, "```js\nflowchart TD\n```", "mermaid 只是提到"]) {
      expect(splitMermaidBlocks(source)).toEqual([{ kind: "text", text: source }]);
    }
  });
});

describe("sizedSvg", () => {
  it("gives Mermaid's page-sized drawing the size of its viewBox", () => {
    const svg = '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 256.125px;" viewBox="0.5 0 256.125 739.25" role="graphics-document document"><g/></svg>';
    expect(sizedSvg(svg)).toBe('<svg width="257" height="740" id="m" xmlns="http://www.w3.org/2000/svg" viewBox="0.5 0 256.125 739.25" role="graphics-document document"><g/></svg>');
    expect(sizedSvg("<svg><g/></svg>")).toBe("<svg><g/></svg>");
  });
});
