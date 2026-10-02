import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { cjkStrong } from "../../src/web/src/markdownStrong.js";

const md = new Marked({ gfm: true, breaks: true });
md.use({ extensions: [cjkStrong] });
const inline = (s: string) => md.parseInline(s) as string;

describe("bold in Chinese messages", () => {
  it("closes a bold that ends in full-width punctuation right before more text", () => {
    expect(inline("**原因：**报道普遍认为")).toBe("<strong>原因：</strong>报道普遍认为");
    expect(inline("**Grok 的隐私风险：**xAI 正被调查")).toBe("<strong>Grok 的隐私风险：</strong>xAI 正被调查");
    expect(inline("说明**“重点”**在这")).toBe("说明<strong>“重点”</strong>在这");
    expect(inline("**注意（重要）**请看")).toBe("<strong>注意（重要）</strong>请看");
  });

  it("renders the reported message with every label bold and no stray asterisks", () => {
    const message = [
      "**原因：**报道普遍认为是 GDPR、欧盟 AI Act 等监管问题。",
      "**Grok 的隐私风险：**xAI 正被爱尔兰 DPC、法国 CNIL 等欧洲监管机构调查。",
      "**绕路：**用 VPN 绕过 Muse 的地区限制会违反 Meta 的条款，我不建议。",
      "**时效：**这几个产品几周就会变。",
    ].join("\n");
    const html = md.parse(message) as string;
    expect(html.match(/<strong>/g)).toHaveLength(4);
    expect(html).not.toContain("**");
    expect(html).toContain("<strong>时效：</strong>这几个产品");
  });

  it("keeps the standard behaviour everywhere else", () => {
    expect(inline("**加粗**正常")).toBe("<strong>加粗</strong>正常");
    expect(inline("**bold** and *em*")).toBe("<strong>bold</strong> and <em>em</em>");
    expect(inline("**外层 *内层* 结束**")).toBe("<strong>外层 <em>内层</em> 结束</strong>");
    expect(inline("***粗斜体***")).toBe("<em><strong>粗斜体</strong></em>");
    expect(inline("`**不是加粗**`")).toBe("<code>**不是加粗**</code>");
    expect(inline("\\*\\*字面星号\\*\\*")).toBe("**字面星号**");
    expect(inline("a ** b ** c")).toBe("a ** b ** c");
    expect(inline("**[链接](https://example.com)：**说明")).toBe('<strong><a href="https://example.com">链接</a>：</strong>说明');
  });
});
