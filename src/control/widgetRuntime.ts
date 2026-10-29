/**
 * `window.aio` inside a widget (widgets.ts injects it into the widget's page). It speaks only
 * to the console frame around it, by postMessage:
 *
 * - frame → console `{aio:"ready"}` until the console answers `{aio:"init", data, title, theme, user, locale}`;
 *   `{aio:"theme", theme}` follows each change of the console's theme.
 * - `{aio:"resize", height}` whenever the page's height changes.
 * - `{aio:"call", id, op:"ai"|"fetch", args}` answered by `{aio:"result", id, ok, value|error}`.
 * - `{aio:"send", text}` puts text into the composer for the person to send; `{aio:"open", url}` opens a link.
 *
 * Opened on its own (a preview in the sandbox), it shows the widget's example data with a
 * default theme, and AI and fetch calls fail with the code PREVIEW.
 */
export const WIDGET_RUNTIME_JS = String.raw`(function(){
"use strict";
var framed = window.parent !== window;
var state = { data: null, title: null, user: null, locale: null, theme: null };
var dataFns = [], themeFns = [], pending = {}, seq = 0, inited = false, readyFn;
var ready = new Promise(function(r){ readyFn = r; });
function post(m){ if (framed) window.parent.postMessage(m, "*"); }
var css = document.createElement("style");
css.textContent = ":root{--aio-bg:#ffffff;--aio-surface:#f6f6f8;--aio-text:#1d1d24;--aio-muted:#6b6b78;--aio-border:#e2e2e8;--aio-accent:#5b5bd6;--aio-attention:#d98a1c;--aio-success:#2f8f6f;--aio-danger:#d0452f;--aio-font:system-ui,-apple-system,'PingFang SC','Noto Sans SC',sans-serif;--aio-radius:12px;color-scheme:light dark}"
  + "@media (prefers-color-scheme:dark){:root:not([data-theme]){--aio-bg:#17171c;--aio-surface:#202028;--aio-text:#ececf1;--aio-muted:#9a9aa8;--aio-border:#33333d}}"
  + "html,body{margin:0;background:transparent;color:var(--aio-text);font-family:var(--aio-font);-webkit-text-size-adjust:100%}";
(document.head || document.documentElement).appendChild(css);
function applyTheme(t){
  if (!t || typeof t !== "object") return;
  state.theme = t;
  var root = document.documentElement, vars = t.vars || {};
  for (var k in vars) if (/^--aio-[a-z-]+$/.test(k) && typeof vars[k] === "string") root.style.setProperty(k, vars[k]);
  if (t.mode === "light" || t.mode === "dark") { root.setAttribute("data-theme", t.mode); root.style.colorScheme = t.mode; }
  themeFns.forEach(function(f){ try { f(t); } catch (e) { console.error(e); } });
}
function start(m){
  state.data = m.data === undefined ? null : m.data;
  state.title = m.title || null; state.user = m.user || null; state.locale = m.locale || null;
  applyTheme(m.theme);
  if (!inited) { inited = true; readyFn(window.aio); }
  dataFns.forEach(function(f){ try { f(state.data); } catch (e) { console.error(e); } });
  size();
}
window.addEventListener("message", function(e){
  if (e.source !== window.parent) return;
  var m = e.data;
  if (!m || typeof m.aio !== "string") return;
  if (m.aio === "init") start(m);
  else if (m.aio === "theme") applyTheme(m.theme);
  else if (m.aio === "result" && pending[m.id]) {
    var p = pending[m.id]; delete pending[m.id];
    if (m.ok) p.resolve(m.value);
    else { var err = new Error((m.error && m.error.message) || "failed"); err.code = (m.error && m.error.code) || "FAILED"; p.reject(err); }
  }
});
function call(op, args){
  if (!framed) { var err = new Error("Not available in a preview"); err.code = "PREVIEW"; return Promise.reject(err); }
  return new Promise(function(resolve, reject){
    var id = "c" + (++seq);
    pending[id] = { resolve: resolve, reject: reject };
    post({ aio: "call", id: id, op: op, args: args });
  });
}
var last = 0;
function size(){
  // The content's own height: the root's scrollHeight is never less than the frame, so a frame could never shrink.
  var h = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body ? document.body.scrollHeight : 0));
  if (h && h !== last) { last = h; post({ aio: "resize", height: h }); }
}
window.aio = {
  ready: ready,
  get data(){ return state.data; },
  get title(){ return state.title; },
  get user(){ return state.user; },
  get locale(){ return state.locale; },
  get theme(){ return state.theme; },
  onData: function(f){ dataFns.push(f); if (inited) f(state.data); },
  onTheme: function(f){ themeFns.push(f); if (state.theme) f(state.theme); },
  ai: { ask: function(input, opts){
    var args = {}; for (var k in (opts || {})) args[k] = opts[k];
    if (typeof input === "string") args.input = input; else args.messages = input;
    return call("ai", args);
  } },
  fetch: function(url, opts){
    var args = { url: String(url) }; for (var k in (opts || {})) args[k] = opts[k];
    return call("fetch", args);
  },
  send: function(text){ post({ aio: "send", text: String(text) }); },
  open: function(url){ if (framed) post({ aio: "open", url: String(url) }); else window.open(String(url), "_blank", "noopener"); },
  resize: size
};
function observe(){
  if (window.ResizeObserver) { var ro = new ResizeObserver(size); ro.observe(document.documentElement); if (document.body) ro.observe(document.body); }
  window.addEventListener("load", size);
  size();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe); else observe();
if (framed) {
  var tries = 0;
  (function hello(){ if (inited || tries++ > 40) return; post({ aio: "ready" }); setTimeout(hello, 300); })();
} else {
  var go = function(){ start({ data: window.__aioExample === undefined ? null : window.__aioExample, title: null, user: null, locale: navigator.language, theme: null }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else setTimeout(go, 0);
}
})();`;
