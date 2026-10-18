/**
 * The clawpage browser SDK: a page's data, from the page itself.
 *
 * `aio-share sdk <dir>` copies it into a page as `clawpage-sdk.js` (and `publish`
 * refreshes that copy), so the page loads it by relative path both published and
 * in a `file://` preview. Its calls follow clawpage.ai's SDK (`new Clawpage()`,
 * `table(name).list/get/put/patch/post/incr/delete`); the page and account come
 * from the page's own address. Opened from `file://` (or anywhere else) it keeps
 * the data in memory, so a preview works without touching the real tables.
 *
 * An owner link carries a token in the fragment (`#cp=...`), which never reaches a
 * server; the SDK takes it and clears it from the address bar, so a link copied
 * from the page afterwards is a visitor's link.
 */
export const CLAWPAGE_SDK_JS = String.raw`/* clawpage-sdk.js - data for a clawpage (managed by Clawpage Agent; republishing refreshes this copy). */
(function (root) {
  "use strict";
  var PAGE = /^\/u\/([A-Za-z0-9_-]{2,40})\/share\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/;

  function ClawpageError(status, code, message) {
    var err = new Error(message || code);
    err.name = "ClawpageError";
    err.status = status;
    err.code = code;
    Object.setPrototypeOf(err, ClawpageError.prototype);
    return err;
  }
  ClawpageError.prototype = Object.create(Error.prototype);
  ClawpageError.prototype.constructor = ClawpageError;

  function takeToken(loc) {
    var m = /(?:^#|&)cp=([^&]+)/.exec(loc.hash || "");
    if (!m) return null;
    var rest = loc.hash.replace(/(^#|&)cp=[^&]+/, "$1").replace(/^#&/, "#");
    try {
      root.history.replaceState(root.history.state, "", loc.pathname + loc.search + (rest === "#" ? "" : rest));
    } catch (e) {
      try { loc.hash = rest === "#" ? "" : rest; } catch (e2) { /* the token stays visible; it still works */ }
    }
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ live: the page's tables

  function live(base, token) {
    function call(method, path, body) {
      var headers = {};
      if (token) headers.authorization = "Bearer " + token;
      if (body !== undefined) headers["content-type"] = "application/json";
      return root.fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", cache: "no-store" })
        .then(function (res) {
          if (res.status === 204) return null;
          return res.text().then(function (text) {
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
            if (!res.ok) throw ClawpageError(res.status, (data && data.error) || "HTTP_" + res.status, (data && data.message) || text || "HTTP " + res.status);
            return data;
          });
        }, function (err) { throw ClawpageError(0, "NETWORK", String(err && err.message || err)); });
    }
    return call;
  }

  // ------------------------------------------------------------------ preview: in memory

  function memory() {
    var tables = {}, seq = 0;
    function table(name) { return tables[name] || (tables[name] = { permission: "private", records: {} }); }
    function now() { return Date.now(); }
    function copy(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
    function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
    function merge(a, b) { var out = {}, k; for (k in a) out[k] = a[k]; for (k in b) out[k] = isObj(b[k]) && isObj(out[k]) ? merge(out[k], b[k]) : b[k]; return out; }
    function summary(key, r) { return { key: key, value: copy(r.value), createdAt: r.createdAt, updatedAt: r.updatedAt }; }
    function write(t, key, value) {
      var r = table(t).records[key], at = now();
      table(t).records[key] = r ? { value: copy(value), createdAt: r.createdAt, updatedAt: at, seq: r.seq } : { value: copy(value), createdAt: at, updatedAt: at, seq: ++seq };
      return summary(key, table(t).records[key]);
    }
    return function (method, path, body) {
      return Promise.resolve().then(function () {
        var parts = path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
        var q = {};
        (path.split("?")[1] || "").split("&").forEach(function (kv) { if (kv) { var i = kv.indexOf("="); q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); } });
        var t = parts[0], key = parts[1];
        if (!t) return { tables: Object.keys(tables).map(function (n) { return { name: n, permission: tables[n].permission, records: Object.keys(tables[n].records).length }; }) };
        var recs = table(t).records;
        if (!key && method === "GET") {
          var keys = Object.keys(recs).sort(function (a, b) { return recs[a].seq - recs[b].seq; });
          var start = q.after ? keys.indexOf(q.after) + 1 : 0, limit = Number(q.limit) || 100;
          var page = keys.slice(start, start + limit);
          return { records: page.map(function (k) { return summary(k, recs[k]); }), nextCursor: start + limit < keys.length ? page[page.length - 1] : null };
        }
        if (!key && method === "POST") return write(t, "rec_" + Math.random().toString(36).slice(2, 10), body.value);
        if (parts[2] === "incr") {
          var base = recs[key] ? recs[key].value : {};
          var next = {}, k; for (k in base) next[k] = base[k];
          next[body.field] = (next[body.field] || 0) + (body.by === undefined ? 1 : body.by);
          return write(t, key, next);
        }
        if (method === "GET") { if (!recs[key]) throw ClawpageError(404, "RECORD_NOT_FOUND", "No record " + key); return summary(key, recs[key]); }
        if (method === "PUT") return write(t, key, body.value);
        if (method === "PATCH") { if (!recs[key]) throw ClawpageError(404, "RECORD_NOT_FOUND", "No record " + key); return write(t, key, merge(recs[key].value, body.value)); }
        if (method === "DELETE") { if (!recs[key]) throw ClawpageError(404, "RECORD_NOT_FOUND", "No record " + key); delete recs[key]; return null; }
        throw ClawpageError(405, "METHOD_NOT_ALLOWED", method);
      });
    };
  }

  // ------------------------------------------------------------------ the API

  function Table(call, name) {
    var path = "/" + encodeURIComponent(name);
    var rec = function (key) { return path + "/" + encodeURIComponent(key); };
    this.name = name;
    this.list = function (opts) {
      opts = opts || {};
      var q = [];
      if (opts.limit) q.push("limit=" + encodeURIComponent(opts.limit));
      if (opts.after) q.push("after=" + encodeURIComponent(opts.after));
      return call("GET", path + (q.length ? "?" + q.join("&") : ""));
    };
    this.listAll = function (opts) {
      var max = (opts && opts.maxRecords) || 1000, out = [], self = this;
      function next(after) {
        return self.list({ limit: Math.min(500, max - out.length), after: after }).then(function (page) {
          out = out.concat(page.records);
          return page.nextCursor && out.length < max ? next(page.nextCursor) : out;
        });
      }
      return next(null);
    };
    this.get = function (key) {
      return call("GET", rec(key)).catch(function (err) { if (err.status === 404 && err.code === "RECORD_NOT_FOUND") return null; throw err; });
    };
    this.put = function (key, value) { return call("PUT", rec(key), { value: value }); };
    this.patch = function (key, value) { return call("PATCH", rec(key), { value: value }); };
    this.post = function (value) { return call("POST", path, { value: value }); };
    this.incr = function (key, field, by) { return call("POST", rec(key) + "/incr", { field: field, by: by === undefined ? 1 : by }); };
    this["delete"] = this.deleteRecord = function (key) {
      return call("DELETE", rec(key)).then(function () { return true; }, function (err) { if (err.status === 404 && err.code === "RECORD_NOT_FOUND") return false; throw err; });
    };
  }

  function Clawpage(opts) {
    if (!(this instanceof Clawpage)) return new Clawpage(opts);
    opts = opts || {};
    var loc = root.location;
    var m = loc && /^https?:$/.test(loc.protocol) ? PAGE.exec(loc.pathname) : null;
    var token = opts.token || (loc ? takeToken(loc) : null);
    this.mode = m || opts.base ? "live" : "preview";
    this.page = m ? m[2] : null;
    this.owner = !!token;
    var call = this.mode === "live" ? live(opts.base || (loc.protocol + "//" + loc.host + "/u/" + m[1] + "/share/" + m[2] + "/.data"), token) : memory();
    if (this.mode === "preview" && root.console) root.console.info("[clawpage] preview: data is kept in memory until the page is published");
    this.table = function (name) { return new Table(call, name); };
    this.tables = function () { return call("GET", "").then(function (r) { return r.tables; }); };
  }

  root.Clawpage = Clawpage;
  root.ClawpageError = ClawpageError;
})(typeof window !== "undefined" ? window : globalThis);
`;
