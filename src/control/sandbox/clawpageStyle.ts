/**
 * The clawpage starter stylesheet: 一站's own neutrals and spacing with a choice of accent palettes,
 * so pages look of a piece with the console instead of all coming out the same green.
 *
 * `aio-share style <dir> [--palette <name>]` copies it into a page as `clawpage-style.css` and names the
 * palette on `<html data-palette>`. The page owns its copy afterwards (publishing does not replace it),
 * so it may change any value. Light and dark follow the visitor's system; `data-scheme="light|dark"` pins one.
 */
export const CLAWPAGE_STYLE_PALETTES = ["indigo", "amber", "harbor", "plum", "pine", "ink"] as const;

export const CLAWPAGE_STYLE_CSS = `/* clawpage-style.css: Clawpage Agent's look for a page. Palette: <html data-palette="indigo|amber|harbor|plum|pine|ink">.
   Change any value here: this copy belongs to the page. Status colors keep one meaning everywhere:
   --done (finished, saved), --you (needs the visitor), --error (failed). */
:root {
  --bg: #f5f4f8; --surface: #ffffff; --raised: #fafafd; --border: #e6e3ee;
  --text: #1d1b26; --text-dim: #6b6878; --hover: rgb(29 27 38 / 0.05);
  --done: #1f8a5b; --done-soft: #e6f5ee; --you: #a15f00; --you-soft: #fff3df; --error: #d4433a; --error-soft: #fdeceb;
  --accent: #5a4fe0; --accent-soft: #eeecff; --on-accent: #ffffff;
  --shadow: 0 1px 2px rgb(20 14 50 / 0.06), 0 8px 24px rgb(20 14 50 / 0.06);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r-sm: 8px; --r: 12px; --r-lg: 16px; --r-pill: 999px;
  color-scheme: light;
}
:root[data-palette="amber"]  { --accent: #9a5a00; --accent-soft: #fff3df; }
:root[data-palette="harbor"] { --accent: #2a63c4; --accent-soft: #e8f0fd; }
:root[data-palette="plum"]   { --accent: #9a3fb8; --accent-soft: #f6e9fb; }
:root[data-palette="pine"]   { --accent: #1b7a50; --accent-soft: #e6f5ee; }
:root[data-palette="ink"]    { --accent: #2b2838; --accent-soft: #ecebf1; }

@media (prefers-color-scheme: dark) {
  :root:not([data-scheme="light"]) {
    --bg: #131219; --surface: #1a1823; --raised: #221f2d; --border: #2d2939;
    --text: #ecebf3; --text-dim: #9d98ae; --hover: rgb(236 235 243 / 0.06);
    --done: #4cc38a; --done-soft: #173126; --you: #ffb547; --you-soft: #3a2c16; --error: #ff7369; --error-soft: #3a1a1a;
    --accent: #8f86ff; --accent-soft: #2a2550; --on-accent: #15131c;
    --shadow: 0 1px 2px rgb(8 6 20 / 0.3), 0 8px 24px rgb(8 6 20 / 0.3);
    color-scheme: dark;
  }
  :root:not([data-scheme="light"])[data-palette="amber"]  { --accent: #ffb547; --accent-soft: #3a2c16; }
  :root:not([data-scheme="light"])[data-palette="harbor"] { --accent: #6aa8ff; --accent-soft: #172a45; }
  :root:not([data-scheme="light"])[data-palette="plum"]   { --accent: #d685e6; --accent-soft: #3a1f42; }
  :root:not([data-scheme="light"])[data-palette="pine"]   { --accent: #4cc38a; --accent-soft: #173126; }
  :root:not([data-scheme="light"])[data-palette="ink"]    { --accent: #d9d6e6; --accent-soft: #2d2939; }
}
:root[data-scheme="dark"] {
  --bg: #131219; --surface: #1a1823; --raised: #221f2d; --border: #2d2939;
  --text: #ecebf3; --text-dim: #9d98ae; --hover: rgb(236 235 243 / 0.06);
  --done: #4cc38a; --done-soft: #173126; --you: #ffb547; --you-soft: #3a2c16; --error: #ff7369; --error-soft: #3a1a1a;
  --accent: #8f86ff; --accent-soft: #2a2550; --on-accent: #15131c;
  --shadow: 0 1px 2px rgb(8 6 20 / 0.3), 0 8px 24px rgb(8 6 20 / 0.3);
  color-scheme: dark;
}
:root[data-scheme="dark"][data-palette="amber"]  { --accent: #ffb547; --accent-soft: #3a2c16; }
:root[data-scheme="dark"][data-palette="harbor"] { --accent: #6aa8ff; --accent-soft: #172a45; }
:root[data-scheme="dark"][data-palette="plum"]   { --accent: #d685e6; --accent-soft: #3a1f42; }
:root[data-scheme="dark"][data-palette="pine"]   { --accent: #4cc38a; --accent-soft: #173126; }
:root[data-scheme="dark"][data-palette="ink"]    { --accent: #d9d6e6; --accent-soft: #2d2939; }

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 var(--font); -webkit-font-smoothing: antialiased; }
.cp-page { max-width: 720px; margin: 0 auto; padding: var(--s5) var(--s4) var(--s7); }
.cp-page.wide { max-width: 1080px; }
h1, h2, h3 { line-height: 1.3; margin: 0 0 var(--s3); letter-spacing: -0.01em; }
h1 { font-size: 26px; font-weight: 700; }
h2 { font-size: 19px; font-weight: 650; }
h3 { font-size: 16px; font-weight: 650; }
p { margin: 0 0 var(--s3); }
a { color: var(--accent); text-underline-offset: 2px; }
small, .cp-dim { color: var(--text-dim); font-size: 13px; }
.cp-eyebrow { color: var(--accent); font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: var(--s1); }
.cp-header { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s5); }

.cp-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s5); box-shadow: var(--shadow); margin-bottom: var(--s4); }
.cp-card.flat { box-shadow: none; }
.cp-stack > * + * { margin-top: var(--s3); }
.cp-row { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
.cp-grid { display: grid; gap: var(--s3); grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.cp-list { list-style: none; margin: 0; padding: 0; }
.cp-list > li { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) 0; border-top: 1px solid var(--border); }
.cp-list > li:first-child { border-top: 0; }
.cp-stat { background: var(--raised); border: 1px solid var(--border); border-radius: var(--r); padding: var(--s3) var(--s4); }
.cp-stat strong { display: block; font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }

.cp-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 44px; padding: 0 var(--s4);
  border: 1px solid var(--border); border-radius: var(--r); background: var(--surface); color: var(--text); font: 600 15px/1 var(--font); cursor: pointer; }
.cp-btn:hover { background: var(--hover); }
.cp-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.cp-btn.primary:hover { filter: brightness(1.06); }
.cp-btn.quiet { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.cp-btn.small { min-height: 34px; padding: 0 var(--s3); font-size: 14px; border-radius: var(--r-sm); }
.cp-btn:disabled { opacity: 0.5; cursor: default; }
.cp-btn:focus-visible, .cp-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.cp-label { display: block; font-size: 14px; font-weight: 600; margin-bottom: var(--s1); }
.cp-input { width: 100%; min-height: 44px; padding: var(--s2) var(--s3); border: 1px solid var(--border); border-radius: var(--r);
  background: var(--raised); color: var(--text); font: 16px/1.4 var(--font); }
textarea.cp-input { min-height: 96px; resize: vertical; }
.cp-field { margin-bottom: var(--s4); }

.cp-chip { display: inline-flex; align-items: center; gap: var(--s1); padding: 2px var(--s2); border-radius: var(--r-pill); font-size: 12px; font-weight: 600;
  background: var(--accent-soft); color: var(--accent); }
.cp-chip.done { background: var(--done-soft); color: var(--done); }
.cp-chip.you { background: var(--you-soft); color: var(--you); }
.cp-chip.error { background: var(--error-soft); color: var(--error); }
.cp-note { padding: var(--s3) var(--s4); border-radius: var(--r); background: var(--accent-soft); font-size: 14px; }
.cp-note.you { background: var(--you-soft); }
.cp-note.error { background: var(--error-soft); color: var(--error); }

.cp-tabs { display: flex; gap: var(--s1); padding: var(--s1); background: var(--hover); border-radius: var(--r); margin-bottom: var(--s4); }
.cp-tabs > button { flex: 1; min-height: 36px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-dim); font: 600 14px/1 var(--font); cursor: pointer; }
.cp-tabs > button[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.cp-progress { height: 8px; border-radius: var(--r-pill); background: var(--hover); overflow: hidden; }
.cp-progress > i { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.cp-empty { text-align: center; color: var(--text-dim); padding: var(--s6) var(--s4); }
.cp-toast { position: fixed; left: 50%; bottom: calc(var(--s5) + env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: calc(100% - 32px);
  padding: var(--s3) var(--s4); border-radius: var(--r); background: var(--text); color: var(--bg); font-size: 14px; box-shadow: var(--shadow); }
dialog.cp-dialog { width: min(92vw, 520px); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s5); background: var(--surface); color: var(--text); }
dialog.cp-dialog::backdrop { background: rgb(0 0 0 / 0.45); }
.cp-footer { margin-top: var(--s6); text-align: center; color: var(--text-dim); font-size: 12px; }

@media (max-width: 480px) {
  .cp-page { padding: var(--s4) var(--s4) var(--s6); }
  .cp-card { padding: var(--s4); border-radius: var(--r); }
  h1 { font-size: 23px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;
