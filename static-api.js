// Search engine of the app, in the browser (GitHub Pages and locally): answers the /api/... URLs of
// app/API.md from the JSON files in data/ (exported by scripts/export_static.py).
//
// Query syntax (as in UN-HRDB): words are lemmatised (data/lemmas.json, simplemma over the corpus) and
// all must occur in one record (implicit AND); AND, OR, NOT (also -word), parentheses; "a phrase" verbatim;
// word* = prefix (sztuczn* -> sztuczny, sztuczność); -ość/-ność nouns also match the adjective stem.
// If a plain query (no operators) finds nothing, any word is enough (relaxed_or).
// Params of /api/search: q, group=doc|para, sort=rel|new|old, limit, offset, year_from, year_to,
// facets (repeatable for several values): outcome, scheme, tax, term, topic, role (OR within a facet),
// warunek, instrument (mode_warunek / mode_instrument = any|all).
window.STATIC_API = (function () {
  "use strict";
  const WORD = /[0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]+(?:-[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]+)?/g;
  const NOUN_OSC = /^(.{6,}?)(no[sś][cć]|o[sś][cć])$/;
  const OUTCOME_LABEL = { "zasadne": "zasadne", "niezasadne": "niezasadne", "częściowo": "częściowo zasadne",
    "zasadne z zastrzeżeniem": "zasadne z zastrzeżeniem" };
  let IDX = null, DOCS = null, LEM = null, DF = null, loading = null;
  const base = (document.currentScript && document.currentScript.src) ? new URL(".", document.currentScript.src).href : "";
  const j = (u) => fetch(base + u).then((r) => { if (!r.ok) throw new Error(r.status + " " + u); return r.json(); });

  function lemma(w) { const l = w.toLowerCase(); return /^\d+$/.test(l) ? l : (LEM[l] || l); }
  function load() {
    if (!loading) loading = Promise.all([j("data/index.json"), j("data/docs.json"), j("data/lemmas.json")]).then(([i, d, l]) => {
      DOCS = d; LEM = l; DF = new Map();
      IDX = i.map((a) => {
        const lem = a[7] ? a[7].split(" ") : [];
        const tf = new Map(); lem.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
        const sec = new Set(a[8] ? a[8].split(" ") : []), tag = new Set(a[9] ? a[9].split(" ") : []);
        const all = new Set([...tf.keys(), ...sec, ...tag]);
        all.forEach((t) => DF.set(t, (DF.get(t) || 0) + 1));
        const doc = d[a[1]];
        return { id: a[0], doc_id: a[1], pkt: a[2], part: a[3], role: a[4], warunki: a[5], page: a[6], tf, sec, tag, all,
          len: lem.length, text: a[10], low: a[10].toLowerCase().replace(/\s+/g, " "), outcome: doc.outcome,
          scheme: doc.scheme_type, term: doc.term, topic: doc.topic, tax: doc.tax, date: doc.date,
          year: +doc.date.slice(0, 4), instr: doc.instrument_tags || [], rep: doc.series_representative || a[1] };
      });
    });
    return loading;
  }

  // ---------- query: tokens -> AST ----------
  function tokenize(q) {
    const out = [], re = /"([^"]*)"|\(|\)|(-?)([0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ][0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ-]*\*?)/g;
    let m;
    while ((m = re.exec(q))) {
      if (m[1] !== undefined) { const p = m[1].toLowerCase().replace(/\s+/g, " ").trim(); if (p) out.push({ t: "phrase", v: p }); }
      else if (m[0] === "(" || m[0] === ")") out.push({ t: m[0] });
      else {
        const w = m[3];
        if (!m[2] && /^(AND|OR|NOT)$/.test(w)) { out.push({ t: w }); continue; }
        if (m[2]) out.push({ t: "NOT" });
        if (w.endsWith("*")) out.push({ t: "prefix", v: w.slice(0, -1).toLowerCase() });
        else { const l = lemma(w); const s = NOUN_OSC.exec(l); out.push({ t: "term", v: l, stem: s ? s[1] : null }); }
      }
    }
    return out;
  }
  function parse(q) {
    const toks = tokenize(q); let i = 0;
    const peek = () => toks[i], eat = () => toks[i++];
    function primary() {
      const t = peek(); if (!t) return null;
      if (t.t === "(") { eat(); const e = orE(); if (peek() && peek().t === ")") eat(); return e; }
      if (t.t === ")") { eat(); return primary(); }
      if (t.t === "phrase" || t.t === "term" || t.t === "prefix") { eat(); return t; }
      eat(); return primary();  // stray operator
    }
    function notE() { if (peek() && peek().t === "NOT") { eat(); const e = notE(); return e && { t: "not", e }; } return primary(); }
    function andE() {
      let left = notE();
      while (peek() && peek().t !== ")" && peek().t !== "OR") { if (peek().t === "AND") eat(); const r = notE(); if (r) left = left ? { t: "and", a: left, b: r } : r; }
      return left;
    }
    function orE() { let left = andE(); while (peek() && peek().t === "OR") { eat(); const r = andE(); if (r) left = left ? { t: "or", a: left, b: r } : r; } return left; }
    const ast = orE();
    const plain = !toks.some((t) => ["AND", "OR", "NOT", "(", ")"].includes(t.t));
    const pos = []; (function walk(n, neg) { if (!n) return; if (n.t === "not") return walk(n.e, !neg);
      if (n.t === "and" || n.t === "or") { walk(n.a, neg); walk(n.b, neg); return; } if (!neg) pos.push(n); })(ast, false);
    return { ast, plain, pos, leaves: toks.filter((t) => ["term", "phrase", "prefix"].includes(t.t)) };
  }
  const leafHit = (r, n) => n.t === "phrase" ? r.low.includes(n.v)
    : n.t === "prefix" ? [...r.all].some((x) => x.startsWith(n.v))
    : r.all.has(n.v) || (n.stem && [...r.all].some((x) => x.startsWith(n.stem)));
  function evalN(r, n) {
    if (!n) return true;
    if (n.t === "and") return evalN(r, n.a) && evalN(r, n.b);
    if (n.t === "or") return evalN(r, n.a) || evalN(r, n.b);
    if (n.t === "not") return !evalN(r, n.e);
    return leafHit(r, n);
  }
  function score(r, pos) {
    let s = 0;
    for (const n of pos) {
      if (n.t === "phrase") { if (r.low.includes(n.v)) s += 3; continue; }
      const key = n.v, idf = Math.log(1 + IDX.length / (1 + (DF.get(key) || 1)));
      const pre = n.t === "prefix" ? n.v : n.stem;
      const tf = r.tf.get(key) || (pre && [...r.tf.keys()].some((x) => x.startsWith(pre)) ? 1 : 0);
      s += idf * (Math.min(tf, 4) / (tf + 1.2 * (0.25 + 0.75 * r.len / 90)) * 2.2 + (r.sec.has(key) ? 1.5 : 0) + (r.tag.has(key) ? 1 : 0));
    }
    return s;
  }
  function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function mark(text, pos, width) {
    const lems = new Set(pos.filter((n) => n.t === "term").map((n) => n.v));
    const pres = pos.filter((n) => n.t === "prefix" || (n.t === "term" && n.stem)).map((n) => n.t === "prefix" ? n.v : n.stem);
    const spans = [];
    for (const m of text.matchAll(WORD)) {
      const l = lemma(m[0]), w = m[0].toLowerCase();
      if (lems.has(l) || pres.some((s) => l.startsWith(s) || w.startsWith(s))) spans.push([m.index, m.index + m[0].length]);
    }
    const low = text.toLowerCase();
    for (const n of pos) if (n.t === "phrase") { let k = low.indexOf(n.v); while (k >= 0) { spans.push([k, k + n.v.length]); k = low.indexOf(n.v, k + 1); } }
    spans.sort((a, b) => a[0] - b[0]);
    let a = 0, b = text.length;
    if (width && text.length > width) { const f = spans.length ? spans[0][0] : 0; a = Math.max(0, f - Math.floor(width / 3)); b = Math.min(text.length, a + width); }
    let out = "", p = a;
    for (const [x, y] of spans) { if (x < p || y > b) continue; out += esc(text.slice(p, x)) + "<mark>" + esc(text.slice(x, y)) + "</mark>"; p = y; }
    out += esc(text.slice(p, b));
    return (a ? "…" : "") + out + (b < text.length ? "…" : "");
  }

  // ---------- filters and facets ----------
  const SINGLE = { outcome: "outcome", scheme: "scheme", term: "term", topic: "topic", role: "role" };
  function filterFn(p, skip) {
    const f = {};
    for (const k of ["outcome", "scheme", "tax", "term", "topic", "role", "warunek", "instrument"]) { const v = p.getAll(k).filter(Boolean); if (v.length && k !== skip) f[k] = v; }
    const yf = +p.get("year_from") || 0, yt = +p.get("year_to") || 9999, useY = skip !== "year";
    const mw = p.get("mode_warunek") === "all", mi = p.get("mode_instrument") === "all";
    return (r) => {
      for (const k in SINGLE) if (f[k] && !f[k].includes(r[SINGLE[k]])) return false;
      if (f.tax && !f.tax.some((t) => r.tax.includes(t))) return false;
      if (f.warunek && !(mw ? f.warunek.every((w) => r.warunki.includes(w)) : f.warunek.some((w) => r.warunki.includes(w)))) return false;
      if (f.instrument && !(mi ? f.instrument.every((w) => r.instr.includes(w)) : f.instrument.some((w) => r.instr.includes(w)))) return false;
      if (useY && (r.year < yf || r.year > yt)) return false;
      return true;
    };
  }
  function facetCounts(rows) {
    const fc = { outcome: {}, scheme: {}, term: {}, topic: {}, tax: {}, year: {}, instrument: {}, role: {}, warunek: {} };
    const inc = (o, k) => { if (k != null) o[k] = (o[k] || 0) + 1; };
    const seen = new Set();
    for (const r of rows) {
      if (!seen.has(r.doc_id)) { seen.add(r.doc_id); inc(fc.outcome, r.outcome); inc(fc.scheme, r.scheme); inc(fc.term, r.term);
        inc(fc.topic, r.topic); inc(fc.year, r.year); r.tax.forEach((t) => inc(fc.tax, t)); r.instr.forEach((t) => inc(fc.instrument, t)); }
      inc(fc.role, r.role); r.warunki.forEach((w) => inc(fc.warunek, w));
    }
    for (const k in fc) if (k !== "year") fc[k] = Object.fromEntries(Object.entries(fc[k]).sort((a, b) => b[1] - a[1]));
    return fc;
  }

  function match(p) {
    const q = (p.get("q") || "").trim();
    const parsed = parse(q);
    let relaxed = false, rows;
    const ok = filterFn(p);
    if (q && parsed.ast) {
      rows = IDX.filter((r) => ok(r) && evalN(r, parsed.ast));
      if (!rows.length && parsed.plain && parsed.leaves.length > 1) {
        const any = parsed.leaves.reduce((a, b) => a ? { t: "or", a, b } : b, null);
        rows = IDX.filter((r) => ok(r) && evalN(r, any)); relaxed = true;
      }
    } else rows = IDX.filter((r) => r.part === "operative" && ok(r));
    return { q, parsed, rows, relaxed };
  }

  async function search(p) {
    await load();
    const group = p.get("group") || "doc", sort = p.get("sort") || "rel";
    const limit = +(p.get("limit") || 20), offset = +(p.get("offset") || 0);
    const { q, parsed, rows: raw, relaxed } = match(p);
    const pos = parsed.pos;
    let rows = raw.map((r) => ({ r, s: q ? score(r, pos) : 0 }));
    const byDate = (a, b) => (sort === "old" ? 1 : -1) * ((a.r.date + a.r.doc_id).localeCompare(b.r.date + b.r.doc_id));
    if (q && sort === "rel") rows.sort((a, b) => b.s - a.s); else rows.sort(byDate);
    const fac = facetCounts(rows.map((x) => x.r));
    // year histogram over all years, ignoring the year filter itself (so bars outside the range stay visible)
    const pNoYear = new URLSearchParams(p); pNoYear.delete("year_from"); pNoYear.delete("year_to");
    if (p.get("year_from") || p.get("year_to")) { const m2 = match(pNoYear); fac.year = facetCounts(m2.rows).year; }
    const snip = (r, w) => mark(r.text, pos, w);
    const common = { q, sort, relaxed_or: relaxed, query_terms: parsed.leaves.map((t) => t.v), facets: fac };
    if (group === "para") {
      const uniq = [], seen = new Map();
      for (const { r } of rows) {
        const key = r.rep + "|" + r.text.toLowerCase().replace(/\W+/g, "").slice(0, 240);
        if (seen.has(key)) seen.get(key).also.push(r); else { const u = { r, also: [] }; seen.set(key, u); uniq.push(u); }
      }
      const hits = uniq.slice(offset, offset + limit).map(({ r, also }) => ({ id: r.id, doc_id: r.doc_id, label: DOCS[r.doc_id].label, date: r.date, pkt: r.pkt,
        part: r.part, role: r.role, warunki: r.warunki, page: r.page, outcome: r.outcome, scheme_type: r.scheme,
        also_in: also.map((x) => ({ id: x.id, label: DOCS[x.doc_id].label, pkt: x.pkt })), snippet: snip(r, 320), text: r.text }));
      return { ...common, total_paragraphs: rows.length, total_unique: uniq.length, total_docs: new Set(rows.map((x) => x.r.doc_id)).size, hits };
    }
    const groups = new Map();
    for (const { r, s } of rows) {
      let g = groups.get(r.rep); if (!g) { g = { score: 0, n: 0, rows: [], members: new Set(), date: r.date }; groups.set(r.rep, g); }
      g.n++; g.members.add(r.doc_id); g.rows.push(r); g.score = Math.max(g.score, s);
    }
    let order = [...groups.entries()];
    if (q && sort === "rel") order.sort((a, b) => b[1].score * (1 + 0.3 * Math.log(1 + b[1].n)) - a[1].score * (1 + 0.3 * Math.log(1 + a[1].n)));
    const hits = order.slice(offset, offset + limit).map(([, g]) => {
      const best = g.rows[0], d = DOCS[best.doc_id];
      const series = d.series_id ? Object.values(DOCS).filter((x) => x.series_id === d.series_id).sort((a, b) => a.date.localeCompare(b.date)).map((x) => x.id) : [d.id];
      return { doc_id: d.id, label: d.label, date: d.date, term: d.term, topic: d.topic, outcome: d.outcome,
        outcome_label: OUTCOME_LABEL[d.outcome] || d.outcome, scheme_type: d.scheme_type, scheme_type_name: d.scheme_type_name,
        tax: d.tax, tax_years: d.tax_years, taxpayer_type: d.taxpayer_type, dissent_noted: d.dissent_noted, instrument_tags: d.instrument_tags || [],
        series_id: d.series_id, series_members: series, matched_members: [...g.members].sort(), hits: g.n, summary: d.summary,
        best: { id: best.id, pkt: best.pkt, part: best.part, role: best.role, page: best.page, snippet: snip(best, 360), text: best.text },
        more: g.rows.slice(1, 4).map((r) => ({ id: r.id, pkt: r.pkt, part: r.part, page: r.page, snippet: snip(r, 220) })) };
    });
    return { ...common, total_paragraphs: q ? rows.length : 0, total_docs: new Set(rows.map((x) => x.r.doc_id)).size, total_groups: groups.size, hits };
  }

  async function doc(id, q) {
    const d = await j(`data/doc/${id}.json`);
    if (q) { await load(); const { pos } = parse(q); d.records.forEach((r) => { r.html = mark(r.text, pos); }); }
    return d;
  }
  const boxCache = new Map();
  async function boxes(recId) {
    const did = recId.split("#")[0];
    if (!boxCache.has(did)) boxCache.set(did, j(`data/boxes/${did}.json`));
    const all = await boxCache.get(did);
    if (!all[recId]) throw new Error("404 " + recId);
    return all[recId];
  }

  async function get(url) {
    const u = new URL(url, location.href), path = decodeURIComponent(u.pathname.replace(/^.*\/api\//, "/api/"));
    if (path === "/api/search") return search(u.searchParams);
    if (path.startsWith("/api/doc/")) return doc(path.slice("/api/doc/".length), u.searchParams.get("q") || "");
    if (path.startsWith("/api/boxes/")) return boxes(path.slice("/api/boxes/".length));
    if (path === "/api/stats") return j("data/stats.json");
    throw new Error("404 " + url);
  }
  return { get, pdfUrl: (id) => `${base}pdf/${id}.pdf`, parse };
})();
