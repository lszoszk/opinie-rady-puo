// Static API for GitHub Pages: answers the same /api/... URLs as app/server.py from JSON files.
// Search: query words -> lemmas (data/lemmas.json, built from the corpus with simplemma); all words in
// one record (AND), else any (OR, relaxed_or); -ość/-ność nouns also match the adjective stem (6+ letters);
// "phrases" verbatim. Scoring approximates the BM25F weights of the server (text, headings 1.5, tags 1).
window.STATIC_API = (function () {
  "use strict";
  const WORD = /[0-9A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]+(?:-[A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]+)?/g;
  const NOUN_OSC = /^(.{6,}?)(no[sś][cć]|o[sś][cć])$/;
  const OUTCOME_LABEL = { "zasadne": "zasadne", "niezasadne": "niezasadne", "częściowo": "częściowo zasadne",
    "zasadne z zastrzeżeniem": "zasadne z zastrzeżeniem" };
  let IDX = null, DOCS = null, LEM = null, DF = null, loading = null;
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status + " " + u); return r.json(); });

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
          rep: doc.series_representative || a[1] };
      });
    });
    return loading;
  }

  function parse(q) {
    const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
    const rest = q.replace(/"[^"]+"/g, " ");
    const terms = (rest.match(WORD) || []).map((w) => { const l = lemma(w); const m = NOUN_OSC.exec(l); return { l, stem: m ? m[1] : null }; });
    return { phrases, terms };
  }
  const has = (r, t) => r.all.has(t.l) || (t.stem && [...r.all].some((x) => x.startsWith(t.stem)));
  function score(r, terms) {
    let s = 0;
    for (const t of terms) {
      const idf = Math.log(1 + IDX.length / (1 + (DF.get(t.l) || 1)));
      const tf = r.tf.get(t.l) || (t.stem && [...r.tf.keys()].some((x) => x.startsWith(t.stem)) ? 1 : 0);
      s += idf * (Math.min(tf, 4) / (tf + 1.2 * (0.25 + 0.75 * r.len / 90)) * 2.2 + (r.sec.has(t.l) ? 1.5 : 0) + (r.tag.has(t.l) ? 1 : 0));
    }
    return s;
  }
  function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function mark(text, terms, phrases, width) {
    const lems = new Set(terms.map((t) => t.l)), stems = terms.map((t) => t.stem).filter(Boolean);
    const spans = [];
    for (const m of text.matchAll(WORD)) {
      const l = lemma(m[0]);
      if (lems.has(l) || stems.some((s) => l.startsWith(s))) spans.push([m.index, m.index + m[0].length]);
    }
    const low = text.toLowerCase();
    for (const p of phrases) { let k = low.indexOf(p); while (k >= 0) { spans.push([k, k + p.length]); k = low.indexOf(p, k + 1); } }
    spans.sort((a, b) => a[0] - b[0]);
    let a = 0, b = text.length;
    if (width && text.length > width) { const f = spans.length ? spans[0][0] : 0; a = Math.max(0, f - Math.floor(width / 3)); b = Math.min(text.length, a + width); }
    let out = "", pos = a;
    for (const [x, y] of spans) { if (x < pos || y > b) continue; out += esc(text.slice(pos, x)) + "<mark>" + esc(text.slice(x, y)) + "</mark>"; pos = y; }
    out += esc(text.slice(pos, b));
    return (a ? "…" : "") + out + (b < text.length ? "…" : "");
  }

  function facets(rows) {
    const fc = { outcome: {}, scheme: {}, term: {}, topic: {}, tax: {}, role: {}, warunek: {} };
    const inc = (o, k) => { if (k != null) o[k] = (o[k] || 0) + 1; };
    const seen = new Set();
    for (const r of rows) {
      if (!seen.has(r.doc_id)) { seen.add(r.doc_id); inc(fc.outcome, r.outcome); inc(fc.scheme, r.scheme); inc(fc.term, r.term); inc(fc.topic, r.topic); r.tax.forEach((t) => inc(fc.tax, t)); }
      inc(fc.role, r.role); r.warunki.forEach((w) => inc(fc.warunek, w));
    }
    for (const k in fc) fc[k] = Object.fromEntries(Object.entries(fc[k]).sort((a, b) => b[1] - a[1]));
    return fc;
  }

  async function search(p) {
    await load();
    const q = (p.get("q") || "").trim(), group = p.get("group") || "doc";
    const limit = +(p.get("limit") || 20), offset = +(p.get("offset") || 0);
    const f = {}; for (const k of ["outcome", "scheme", "tax", "term", "topic", "role", "warunek"]) if (p.get(k)) f[k] = p.get(k);
    const ok = (r) => (!f.outcome || r.outcome === f.outcome) && (!f.scheme || r.scheme === f.scheme) && (!f.term || r.term === f.term) &&
      (!f.topic || r.topic === f.topic) && (!f.role || r.role === f.role) && (!f.tax || r.tax.includes(f.tax)) && (!f.warunek || r.warunki.includes(f.warunek));
    const { phrases, terms } = parse(q);
    let rows, relaxed = false;
    if (q) {
      const run = (and) => IDX.filter((r) => ok(r) && phrases.every((ph) => r.low.includes(ph)) &&
        (terms.length === 0 || (and ? terms.every((t) => has(r, t)) : terms.some((t) => has(r, t)))));
      rows = run(true);
      if (!rows.length && terms.length > 1) { rows = run(false); relaxed = true; }
      rows = rows.map((r) => ({ r, s: score(r, terms) + phrases.length })).sort((a, b) => b.s - a.s).slice(0, 3000);
    } else {
      rows = IDX.filter((r) => r.part === "operative" && ok(r)).sort((a, b) => (b.date + b.doc_id).localeCompare(a.date + a.doc_id)).map((r) => ({ r, s: 0 }));
    }
    const fac = facets(rows.map((x) => x.r));
    const snip = (r, w) => mark(r.text, terms, phrases, w);
    if (group === "para") {
      const uniq = [], seen = new Map();
      for (const { r } of rows) {
        const key = r.rep + "|" + r.text.toLowerCase().replace(/\W+/g, "").slice(0, 240);
        if (seen.has(key)) seen.get(key).also.push(r); else { const u = { r, also: [] }; seen.set(key, u); uniq.push(u); }
      }
      const hits = uniq.slice(offset, offset + limit).map(({ r, also }) => ({ id: r.id, doc_id: r.doc_id, label: DOCS[r.doc_id].label, pkt: r.pkt,
        part: r.part, role: r.role, warunki: r.warunki, page: r.page, outcome: r.outcome, scheme_type: r.scheme,
        also_in: also.map((x) => ({ id: x.id, label: DOCS[x.doc_id].label, pkt: x.pkt })), snippet: snip(r, 320) }));
      return { q, relaxed_or: relaxed, total_paragraphs: rows.length, total_unique: uniq.length,
        total_docs: new Set(rows.map((x) => x.r.doc_id)).size, hits, facets: fac };
    }
    const groups = new Map();
    for (const { r, s } of rows) {
      let g = groups.get(r.rep); if (!g) { g = { score: 0, n: 0, rows: [], members: new Set() }; groups.set(r.rep, g); }
      g.n++; g.members.add(r.doc_id); g.rows.push(r); g.score = Math.max(g.score, s);
    }
    let order = [...groups.entries()];
    if (q) order.sort((a, b) => b[1].score * (1 + 0.3 * Math.log(1 + b[1].n)) - a[1].score * (1 + 0.3 * Math.log(1 + a[1].n)));
    const hits = order.slice(offset, offset + limit).map(([, g]) => {
      const best = g.rows[0], d = DOCS[best.doc_id];
      const series = d.series_id ? Object.values(DOCS).filter((x) => x.series_id === d.series_id).sort((a, b) => a.date.localeCompare(b.date)).map((x) => x.id) : [d.id];
      return { doc_id: d.id, label: d.label, date: d.date, term: d.term, topic: d.topic, outcome: d.outcome,
        outcome_label: OUTCOME_LABEL[d.outcome] || d.outcome, scheme_type: d.scheme_type, scheme_type_name: d.scheme_type_name,
        tax: d.tax, tax_years: d.tax_years, taxpayer_type: d.taxpayer_type, dissent_noted: d.dissent_noted,
        series_id: d.series_id, series_members: series, matched_members: [...g.members].sort(), hits: g.n, summary: d.summary,
        best: { id: best.id, pkt: best.pkt, part: best.part, role: best.role, page: best.page, snippet: snip(best, 360) },
        more: g.rows.slice(1, 4).map((r) => ({ id: r.id, pkt: r.pkt, part: r.part, page: r.page, snippet: snip(r, 220) })) };
    });
    return { q, relaxed_or: relaxed, total_paragraphs: q ? rows.length : 0, total_docs: new Set(rows.map((x) => x.r.doc_id)).size,
      total_groups: groups.size, hits, facets: fac };
  }

  async function doc(id, q) {
    const d = await j(`data/doc/${id}.json`);
    if (q) { await load(); const { phrases, terms } = parse(q); d.records.forEach((r) => { r.html = mark(r.text, terms, phrases); }); }
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
  return { get, pdfUrl: (id) => `pdf/${id}.pdf` };
})();
