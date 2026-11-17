"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const LIMIT = 20;
  const FACETS = [
    ["outcome", "Rozstrzygnięcie"], ["scheme", "Schemat optymalizacyjny"], ["tax", "Podatek"],
    ["term", "Kadencja"], ["topic", "Temat"], ["role", "Rola punktu"], ["warunek", "Warunek"], ["instrument", "Instrumenty"],
  ];
  const FKEYS = FACETS.map((f) => f[0]);
  const OUTCOME_NAME = {
    "zasadne": "zasadne", "niezasadne": "niezasadne", "częściowo": "częściowo zasadne",
    "zasadne z zastrzeżeniem": "zasadne z zastrzeżeniem",
  };
  const OUTCOME_CLS = {
    "zasadne": "o-ok", "niezasadne": "o-no", "częściowo": "o-part", "zasadne z zastrzeżeniem": "o-res",
  };
  const TOPIC_NAME = { gaar: "GAAR", korzysci_umowne: "Ograniczenie korzyści umownych" };
  const OTHER_NAME = { tsue: "TSUE", nsa_wsa: "NSA / WSA", tk: "TK", mf: "MF (interpretacje, objaśnienia)" };
  const PDF_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }
  const fmtDate = (s) => (s || "").replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, m, d) => `${+d}.${m}.${y}`);
  const idLabel = (id) => { const m = /rpuo-(\d{4})-(\d+)/.exec(id || ""); return m ? `Uchwała nr ${+m[2]}/${m[1]}` : id; };
  const recToken = (id) => (id || "").split("#")[1] || "";
  const docOf = (id) => (id || "").split("#")[0];
  const debounce = (fn, ms) => { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.cancel = () => clearTimeout(t); return f; };
  const getJSON = async (url, signal) => {
    if (window.STATIC_API) return window.STATIC_API.get(url);  // GitHub Pages: static data, search in the browser
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  };
  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200);
  }
  const schemeNames = {};
  const learnSchemes = (hits) => hits.forEach((x) => { if (x.scheme_type && x.scheme_type_name) schemeNames[x.scheme_type] = x.scheme_type_name; });
  const schemeLabel = (k) => (schemeNames[k] ? `${k} – ${schemeNames[k]}` : k);
  function facetValueLabel(facet, v) {
    if (facet === "outcome") return OUTCOME_NAME[v] || v;
    if (facet === "scheme") return schemeLabel(v);
    if (facet === "topic") return TOPIC_NAME[v] || v;
    return v;
  }
  const outcomeBadge = (key, label) => h("span", { class: `badge ${OUTCOME_CLS[key] || ""}`, title: "Rozstrzygnięcie: zastosowanie art. 119a " + (OUTCOME_NAME[key] || label || key) }, OUTCOME_NAME[key] || label || key);
  const schemeBadge = (k) => k ? h("span", { class: "badge scheme", title: schemeNames[k] || "Schemat optymalizacyjny " + k }, k) : null;

  // ---------- storage (every access guarded: works without localStorage) ----------
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const plUchwal = (n) => (n === 1 ? "uchwała" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "uchwały" : "uchwał");
  const SORTS = ["rel", "new", "old"];

  // ---------- state & hash ----------
  const SEM_BASE = (location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "" : "https://150.254.115.204/gaar-api";
  const RERANK_KEY = "rpuo.rerank";
  const state = { q: "", sem: false, rerank: ls.get(RERANK_KEY) === "1",  /* off by default: not better in tests, an extra Voyage call per query */ group: "doc", sort: "", filters: {}, yf: "", yt: "", mode: { warunek: "any", instrument: "any" }, doc: "", rec: "", view: "html" };
  const yearOk = (v) => (/^\d{4}$/.test(v || "") ? v : "");
  function parseHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    const s = { q: p.get("q") || "", sem: p.get("m") === "sem", group: p.get("group") === "para" ? "para" : "doc", sort: SORTS.includes(p.get("sort")) ? p.get("sort") : "", filters: {},
      yf: yearOk(p.get("year_from")), yt: yearOk(p.get("year_to")),
      mode: { warunek: p.get("mode_warunek") === "all" ? "all" : "any", instrument: p.get("mode_instrument") === "all" ? "all" : "any" },
      doc: p.get("doc") || "", rec: p.get("rec") || "", view: p.get("view") === "pdf" ? "pdf" : "html" };
    for (const k of FKEYS) { const v = p.getAll(k).filter(Boolean); if (v.length) s.filters[k] = [...new Set(v)]; }
    if (!s.doc) s.rec = "";
    return s;
  }
  // search params shared by the hash and /api/search (arrays = repeated keys)
  function searchParams(s) {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    if (s.group === "para") p.set("group", "para");
    if (s.sort) p.set("sort", s.sort);
    for (const k of FKEYS) for (const v of s.filters[k] || []) p.append(k, v);
    if (s.yf) p.set("year_from", s.yf);
    if (s.yt) p.set("year_to", s.yt);
    if (s.mode.warunek === "all") p.set("mode_warunek", "all");
    if (s.mode.instrument === "all") p.set("mode_instrument", "all");
    return p;
  }
  function buildHash(s) {
    const p = searchParams(s);
    if (s.sem) p.set("m", "sem");
    if (s.doc) { p.set("doc", s.doc); if (s.rec) p.set("rec", s.rec); if (s.view === "pdf") p.set("view", "pdf"); }
    return p.toString();
  }
  const semActive = (s = state) => !!(s.sem && s.q);  // "Znaczenie" needs a query; without one we browse lexically
  const effSort = (s = state) => (semActive(s) ? "rel" : s.q ? (s.sort || "rel") : (s.sort === "old" ? "old" : "new"));
  // changes -> new hash; push (default) creates history entry; replace edits current
  function nav(changes, replace) {
    const next = { ...state, ...changes };
    if (!next.doc) next.rec = "";
    const hash = buildHash(next);
    if (hash === location.hash.replace(/^#/, "")) { if (replace) apply(); return; }
    if (replace) { history.replaceState(null, "", "#" + hash); apply(); }
    else location.hash = hash; // hashchange -> apply
  }
  const searchKey = (s) => JSON.stringify([s.q, semActive(s) ? (s.rerank ? "sem+" : "sem") : "", s.group, effSort(s), FKEYS.map((k) => s.filters[k] || []), s.yf, s.yt, s.mode]);
  const nActive = (s = state) => FKEYS.reduce((n, k) => n + (s.filters[k] || []).length, 0) + (s.yf || s.yt ? 1 : 0);

  // ---------- recent searches ----------
  const RECENT_KEY = "rpuo.recent";
  const getRecent = () => { try { const a = JSON.parse(ls.get(RECENT_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 10) : []; } catch { return []; } };
  function saveRecent(q) {
    q = (q || "").trim(); if (!q) return;
    const a = getRecent().filter((x) => x.toLowerCase() !== q.toLowerCase()); a.unshift(q);
    ls.set(RECENT_KEY, JSON.stringify(a.slice(0, 10)));
  }
  const SAMPLES = ["znak towarowy", "\"czynność odpowiednia\"", "fundacja OR darowizna", "sztuczn*", "znak towarowy -licencja"];
  // run a query as an explicit action (examples, history, "Spróbuj")
  function runQuery(q) { $("q").value = q; saveRecent(q); closeRecent(); nav({ q }, false); }

  // ---------- search ----------
  let results = { hits: [], total: 0, offset: 0 }, searchCtl = null, lastKey = null;
  const apiParams = (extra) => { const p = searchParams(state); p.set("sort", effSort()); p.set("group", state.group); for (const [k, v] of Object.entries(extra)) p.set(k, v); return p; };
  let searchSeq = 0;
  // semantic + lexical hybrid search on our server (plain fetch, never STATIC_API)
  async function getSemantic(p, signal) {
    const r = await fetch(`${SEM_BASE}/api/semantic?${p}`, { signal });
    if (r.status === 429) { const e = new Error("429"); e.rate = true; throw e; }
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok || !d || d.error || !Array.isArray(d.hits)) { const e = new Error("semantic unavailable"); e.unavailable = true; throw e; }
    return d;
  }
  function semUnavailable(msg) {
    $("summary").textContent = msg;
    $("results").textContent = ""; $("moreBtn").hidden = true; $("notice").hidden = true; $("try").hidden = true;
    $("results").append(h("div", { class: "empty sem-down" }, h("p", null, msg + "."),
      h("button", { type: "button", class: "btn", onclick: () => nav({ sem: false }) }, "Wróć do wyszukiwania po słowach")));
  }
  async function runSearch(append) {
    const seq = ++searchSeq;
    if (searchCtl) searchCtl.abort();
    searchCtl = new AbortController();
    const offset = append ? results.hits.length : 0;
    const sem = semActive();
    const p = apiParams({ limit: LIMIT, offset });
    if (sem) { p.delete("sort"); p.set("mode", "hybrid"); if (state.rerank) p.set("rerank", "1"); }
    if (!append) $("summary").textContent = "Szukam…";
    try {
      const d = sem ? await getSemantic(p, searchCtl.signal) : await getJSON("/api/search?" + p, searchCtl.signal);
      learnSchemes(d.hits);
      // counts of a facet with its own selection ignore that selection, so more values can be added (OR within a facet)
      if (!append && !sem) await Promise.all(FKEYS.filter((k) => (state.filters[k] || []).length).map(async (k) => {
        const s2 = { ...state, filters: { ...state.filters } }; delete s2.filters[k];
        const p2 = searchParams(s2); p2.set("sort", effSort()); p2.set("group", state.group); p2.set("limit", 0);
        try { const o = await getJSON("/api/search?" + p2, searchCtl.signal); if (o.facets && o.facets[k]) d.facets[k] = o.facets[k]; } catch (e) { if (e.name === "AbortError") throw e; }
      }));
      if (seq !== searchSeq) return;
      if (append) { results.hits = results.hits.concat(d.hits); }
      else { results = { hits: d.hits, offset: 0 }; }
      results.d = d;
      renderResults(append ? d.hits : null);
      renderFacets(d.facets || {});
      renderChips();
    } catch (e) {
      if (e.name === "AbortError" || seq !== searchSeq) return;
      if (e.rate) { toast("Za dużo zapytań – spróbuj za minutę"); if (append) return; semUnavailable("Za dużo zapytań – spróbuj za minutę"); }
      else if (sem) { if (append) { toast("Wyszukiwanie semantyczne jest chwilowo niedostępne"); return; } semUnavailable("Wyszukiwanie semantyczne jest chwilowo niedostępne"); }
      else $("summary").textContent = "Błąd wyszukiwania: " + e.message;
    }
  }

  const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  function chipBtn(title, label, on) {
    return h("button", { class: "chip", type: "button", "aria-label": `Usuń filtr ${title}: ${label}`, onclick: on },
      h("span", { class: "chip-k" }, title + ": "), label, h("span", { "aria-hidden": "true" }, " ×"));
  }
  function renderChips() {
    const box = $("chips"); box.textContent = "";
    for (const k of FKEYS) {
      const title = FACETS.find((f) => f[0] === k)[1];
      for (const v of state.filters[k] || []) box.append(chipBtn(title, facetValueLabel(k, v), () => setFilter(k, v)));
    }
    if (state.yf || state.yt) {
      const a = state.yf || state.yt, b = state.yt || state.yf;
      box.append(chipBtn("Lata", a === b ? a : `${a}–${b}`, () => setYears("", "")));
    }
    const nf = nActive();
    if (nf) box.append(h("button", { type: "button", class: "link chips-clear", onclick: clearAll }, "Wyczyść"));
    $("clearBtn").hidden = !nf;
    $("filtersBtn").textContent = nf ? `Filtry (${nf})` : "Filtry";
  }
  function clearAll() { nav({ filters: {}, yf: "", yt: "", mode: { warunek: "any", instrument: "any" } }); }
  function setFilter(k, v) {
    const cur = state.filters[k] || [], f = { ...state.filters };
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    if (next.length) f[k] = next; else delete f[k];
    nav({ filters: f });
  }
  const setYears = (yf, yt) => nav({ yf: String(yf || ""), yt: String(yt || "") });

  // ----- year histogram -----
  let lastYear = {};
  function buildHisto(counts) {
    const years = [...new Set([...YEARS, ...Object.keys(counts).map(Number)])].sort((a, b) => a - b);
    const max = Math.max(1, ...years.map((y) => counts[y] || 0));
    const lo = +state.yf || +state.yt || 0, hi = +state.yt || +state.yf || 0, ranged = !!(lo || hi);
    const bars = h("div", { class: "hbars" }, years.map((y) => {
      const n = counts[y] || 0, on = ranged && y >= lo && y <= hi;
      return h("button", { type: "button", class: "hbar" + (n ? "" : " zero"), "aria-pressed": String(on), "aria-label": `${y}: ${n} ${plUchwal(n)}`,
        title: `${y}: ${n} ${plUchwal(n)} · Klik: tylko ten rok · Shift+klik: rozszerz zakres`, onclick: (e) => {
          if (e.shiftKey && ranged) setYears(Math.min(lo, y), Math.max(hi, y));
          else if (lo === y && hi === y) setYears("", "");
          else setYears(y, y);
        } },
        h("span", { class: "hb-n", "aria-hidden": "true" }, String(n)),
        h("span", { class: "hb-track", "aria-hidden": "true" }, h("span", { class: "hb-fill", style: `height:${n ? Math.max(4, Math.round((n / max) * 100)) : 0}%` })),
        h("span", { class: "hb-y", "aria-hidden": "true" }, "\u2019" + String(y).slice(-2)));
    }));
    return h("div", { class: "histo", role: "group", "aria-label": "Uchwały według roku" },
      h("div", { class: "histo-h" }, h("span", null, "Rok uchwały"), h("button", { type: "button", class: "link tiny", hidden: !ranged, onclick: () => setYears("", "") }, "wszystkie lata")), bars,
      h("div", { class: "histo-tip" }, "Klik: ten rok · Shift+klik: zakres"));
  }

  // ----- facets -----
  const facetFind = {}, facetClosed = {};
  const NORM = (s) => (s || "").toLowerCase();
  function renderFacets(facets) {
    lastYear = facets.year || {};
    const box = $("facets");
    const focusKey = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    const scroller = window.matchMedia("(min-width: 900px)").matches ? $("sidebar") : box, st = scroller.scrollTop;
    const frag = document.createDocumentFragment();
    frag.append(h("div", { class: "histo-side" }, buildHisto(lastYear)));
    for (const [k, title] of FACETS) {
      const data = { ...(facets[k] || {}) };
      const act = state.filters[k] || [];
      for (const a of act) if (!(a in data)) data[a] = 0;
      const keys = Object.keys(data);
      if (!keys.length) continue;
      if (k === "scheme" || k === "term") keys.sort();
      else keys.sort((a, b) => data[b] - data[a] || a.localeCompare(b, "pl"));
      const closed = k in facetClosed ? facetClosed[k] : (k === "instrument" || k === "role") && !act.length;
      const det = h("details", { class: "facet", open: !closed, "data-facet": k, ontoggle: (e) => { facetClosed[k] = !e.target.open; } },
        h("summary", null, title, act.length ? h("span", { class: "sel-n" }, ` (${act.length})`) : null));
      if (k === "warunek" || k === "instrument") {
        const mk = (val, text, tip) => h("button", { type: "button", "aria-pressed": String(state.mode[k] === val), title: tip, onclick: () => nav({ mode: { ...state.mode, [k]: val } }) }, text);
        det.append(h("div", { class: "facet-tools" },
          h("div", { class: "seg mini", role: "group", "aria-label": `Dopasowanie: ${title}` }, mk("any", "którykolwiek", "Uchwały z którąkolwiek z wybranych wartości"), mk("all", "wszystkie", "Uchwały ze wszystkimi wybranymi wartościami")),
          h("input", { type: "search", class: "facet-find", "aria-label": `Filtruj listę: ${title}`, placeholder: "Filtruj listę…", value: facetFind[k] || "", spellcheck: "false", "data-fk": "find|" + k,
            oninput: (e) => { facetFind[k] = e.target.value; applyFind(det, k); } })));
      }
      const ul = h("ul", { class: "facet-list" });
      for (const v of keys) {
        const on = act.includes(v), lab = facetValueLabel(k, v);
        ul.append(h("li", { "data-l": NORM(lab) }, h("label", { class: "facet-item" + (on ? " on" : ""), title: lab },
          h("input", { type: "checkbox", checked: on, "data-fk": k + "|" + v, onchange: () => setFilter(k, v) }),
          h("span", { class: "fl" }, lab), h("span", { class: "fc" }, String(data[v])))));
      }
      det.append(ul); applyFind(det, k); frag.append(det);
    }
    box.replaceChildren(frag);
    scroller.scrollTop = st;
    if (focusKey) { const el = [...box.querySelectorAll("[data-fk]")].find((x) => x.dataset.fk === focusKey); if (el) el.focus({ preventScroll: true }); }
  }
  function applyFind(det, k) {
    const t = NORM(facetFind[k]).trim();
    det.querySelectorAll(".facet-list li").forEach((li) => { li.hidden = !!t && !li.dataset.l.includes(t) && !li.querySelector("input").checked; });
  }

  function snippetEl(item, doc, extra) {
    const where = item.part === "operative" ? "opinia" : item.part === "preamble" ? "nagłówek" : item.part === "note" ? "adnotacja" : item.part === "signature" ? "podpis" : (item.pkt != null ? `pkt ${item.pkt}` : "akapit");
    const lab = h("span", { class: "sn-lab" }, where + (item.page ? `, s. ${item.page}` : ""));
    return h("div", { class: "snip" },
      h("button", { type: "button", class: "snippet", title: "Otwórz w uchwale", onclick: () => nav({ doc, rec: recToken(item.id) }) },
        lab, h("span", { class: "sn-text", html: item.snippet || "" }), extra || null));
  }
  // snippets are clamped to ~6 lines in CSS; add a "więcej" toggle where the text really overflows
  function markClamps() {
    document.querySelectorAll("#results .snip:not([data-cl])").forEach((sn) => {
      const t = sn.querySelector(".sn-text");
      if (!t || !t.clientHeight) return; // hidden for now; checked again when shown
      sn.dataset.cl = "1";
      if (t.scrollHeight <= t.clientHeight + 2) return;
      const b = h("button", { type: "button", class: "snip-more", "aria-expanded": "false", onclick: () => {
        const o = sn.classList.toggle("open"); b.textContent = o ? "mniej" : "więcej"; b.setAttribute("aria-expanded", String(o));
      } }, "więcej");
      sn.append(b);
    });
  }

  function docCard(x) {
    const card = h("article", { class: "card" });
    const title = h("button", { type: "button", class: "card-title", onclick: () => nav({ doc: x.doc_id, rec: x.best ? recToken(x.best.id) : "" }) }, fmtDate(x.label));
    const badges = h("div", { class: "badges" }, outcomeBadge(x.outcome, x.outcome_label), schemeBadge(x.scheme_type),
      ...(x.tax || []).map((t) => h("span", { class: "badge plain" }, t)),
      x.term ? h("span", { class: "badge plain", title: "Kadencja" }, "kad. " + x.term) : null,
      x.topic === "korzysci_umowne" ? h("span", { class: "badge plain" }, TOPIC_NAME.korzysci_umowne) : null,
      x.dissent_noted ? h("span", { class: "badge dissent", title: "Do opinii zgłoszono zdania odrębne" }, "zdania odrębne") : null);
    card.append(h("div", { class: "card-head" }, title, badges));
    if (x.summary) card.append(h("p", { class: "card-sum" }, x.summary));
    const members = x.series_members || [];
    if (members.length > 1) {
      const list = h("ul", { class: "series-list", hidden: true }, members.map((m) => h("li", null, h("button", { type: "button", class: "link", onclick: () => nav({ doc: m, rec: "" }) }, idLabel(m)),
        (x.matched_members || []).includes(m) ? h("span", { class: "muted" }, " (trafienie)") : null)));
      const btn = h("button", { type: "button", class: "series-btn", "aria-expanded": "false", onclick: () => { list.hidden = !list.hidden; btn.setAttribute("aria-expanded", String(!list.hidden)); } }, `seria × ${members.length}`);
      card.append(h("div", { class: "series" }, btn, list));
    }
    if (x.best) {
      const more = x.more || [];
      let moreBox = null;
      const body = h("div", { class: "snips" }, snippetEl(x.best, x.doc_id));
      if (more.length) {
        moreBox = h("div", { class: "more-snips", hidden: true }, more.map((m) => snippetEl(m, m.doc_id || x.doc_id)));
        const tb = h("button", { type: "button", class: "link more-toggle", "aria-expanded": "false", onclick: () => { moreBox.hidden = !moreBox.hidden; tb.setAttribute("aria-expanded", String(!moreBox.hidden)); tb.textContent = moreBox.hidden ? `+${more.length} trafień` : "Ukryj trafienia"; requestAnimationFrame(markClamps); } }, `+${more.length} trafień`);
        body.append(tb, moreBox);
      }
      if (x.hits > 1 + more.length) body.append(h("div", { class: "muted small" }, `Łącznie punktów z trafieniem: ${x.hits}`));
      card.append(body);
    }
    return card;
  }
  function paraCard(x) {
    const where = x.part === "operative" ? "opinia" : x.pkt != null ? `pkt ${x.pkt}` : "akapit";
    return h("article", { class: "card" },
      h("div", { class: "card-head" },
        h("button", { type: "button", class: "card-title", onclick: () => nav({ doc: x.doc_id, rec: recToken(x.id) }) }, `${fmtDate(x.label)}, ${where}`),
        h("div", { class: "badges" }, outcomeBadge(x.outcome), schemeBadge(x.scheme_type), x.role ? h("span", { class: "badge plain" }, x.role) : null,
          ...(x.warunki || []).map((w) => h("span", { class: "badge chipw" }, w)))),
      h("div", { class: "snips" }, snippetEl(x, x.doc_id)),
      // the same point in other resolutions of the series (collapsed by the API)
      (x.also_in || []).length ? h("div", { class: "also" }, `Ten sam punkt także w ${x.also_in.length} uchwałach serii: `,
        ...x.also_in.flatMap((a, i) => [i ? ", " : "", h("button", { type: "button", class: "linkish",
          onclick: () => nav({ doc: a.id.split("#")[0], rec: recToken(a.id) }) },
          `${a.label.replace(/^Uchwała nr /, "").replace(/ z .*$/, "")}${a.pkt != null ? ` pkt ${a.pkt}` : ""}`)])) : null);
  }

  function renderResults(appended) {
    const d = results.d, box = $("results");
    const para = state.group === "para";
    const total = para ? (d.total_unique ?? d.total_paragraphs) : (d.total_groups ?? d.total_docs);
    if (!appended) box.textContent = "";
    (appended || results.hits).forEach((x) => box.append(para ? paraCard(x) : docCard(x)));
    const browse = !state.q;
    $("summary").textContent = (para ? `Punkty: ${d.total_unique ?? d.total_paragraphs}` + (d.total_unique != null && d.total_unique !== d.total_paragraphs ? ` (z powtórzeniami w seriach ${d.total_paragraphs})` : "") : `Uchwały: ${d.total_groups ?? d.total_docs}` + (d.total_docs != null && d.total_groups != null && d.total_docs !== d.total_groups ? ` (w seriach łącznie ${d.total_docs})` : "") + `, punkty z trafieniem: ${d.total_paragraphs}`) + (browse ? " · przeglądanie" : "") + (semActive() ? " · wg znaczenia" : "");
    const n = $("notice");
    const relaxed = d.relaxed_or && results.hits.length > 0;
    n.hidden = !relaxed;
    n.textContent = relaxed ? "Żaden punkt nie zawiera wszystkich słów – pokazuję dowolne." : "";
    if (relaxed) n.append(" ", h("button", { type: "button", class: "link", onclick: () => openModal() }, "Co to znaczy?"));
    if (!results.hits.length) box.append(h("p", { class: "empty" }, "Brak wyników. Spróbuj mniej słów albo usuń filtry."));
    $("try").hidden = !!(state.q && results.hits.length);
    $("moreBtn").hidden = results.hits.length >= total || !d.hits.length;
    $("applyBtn").textContent = `Pokaż wyniki (${total})`;
    requestAnimationFrame(markClamps);
  }

  // ---------- drawer ----------
  const drawer = { doc: null, data: null, id: "", pdf: null, token: 0, lastFocus: null, io: null };
  const docCache = new Map();

  function citation(d, r) {
    const base = `Uchwała Rady do Spraw Przeciwdziałania Unikaniu Opodatkowania nr ${d.nr}/${d.number_year} z ${fmtDate(d.date)} r.`;
    if (r.part === "operative") return base + ", opinia";
    if (r.pkt != null) return base + `, pkt ${r.pkt}`;
    return base + `, s. ${r.page_from}`;
  }
  async function copyText(t, msg) {
    try { await navigator.clipboard.writeText(t); }
    catch { const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = t; document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); }
    toast(msg || "Skopiowano cytat");
  }

  // metadata (>=900px) and TOC (>=1100px) are always open side/top blocks; below that they are collapsible <details>
  const mqMeta = window.matchMedia("(min-width: 900px)"), mqToc = window.matchMedia("(min-width: 1100px)");
  function syncDetails() {
    const mw = $("dMetaWrap"); if (mw) mw.open = mqMeta.matches;
    document.querySelectorAll("details.toc").forEach((t) => { t.open = mqToc.matches; });
  }
  mqMeta.addEventListener("change", syncDetails); mqToc.addEventListener("change", syncDetails);
  document.addEventListener("toggle", (e) => {
    const t = e.target;
    if (t.id === "dMetaWrap" && mqMeta.matches && !t.open) t.open = true;
    else if (t.classList && t.classList.contains("toc") && mqToc.matches && !t.open) t.open = true;
  }, true);

  function openDrawerShell() {
    if ($("drawer").hidden) {
      drawer.lastFocus = document.activeElement;
      $("drawer").hidden = false; $("backdrop").hidden = false;
      document.body.classList.add("noscroll");
      requestAnimationFrame(() => { $("drawer").classList.add("open"); $("backdrop").classList.add("open"); });
      $("dClose").focus();
    }
  }
  function closeDrawerShell() {
    if ($("drawer").hidden) return;
    $("drawer").classList.remove("open"); $("backdrop").classList.remove("open");
    $("drawer").hidden = true; $("backdrop").hidden = true;
    document.body.classList.remove("noscroll");
    drawer.doc = null; drawer.token++; teardownPdf();
    if (drawer.lastFocus && drawer.lastFocus.focus) try { drawer.lastFocus.focus(); } catch {}
  }

  async function openDoc(id) {
    openDrawerShell();
    drawer.doc = id; drawer.data = null; const tok = ++drawer.token;
    $("dTitle").textContent = idLabel(id); $("dBadges").textContent = ""; $("dMeta").textContent = ""; $("dRecInfo").textContent = ""; syncDetails();
    $("dBody").textContent = "Ładuję…"; $("pageInd").hidden = true;
    const key = id + "|" + state.q;
    try {
      let data = docCache.get(key);
      if (!data) { data = await getJSON(`/api/doc/${encodeURIComponent(id)}?q=${encodeURIComponent(state.q)}`); docCache.set(key, data); }
      if (tok !== drawer.token) return;
      drawer.data = data;
      renderDrawerHead(data);
      showView(true);
    } catch (e) {
      if (tok === drawer.token) $("dBody").textContent = "Nie udało się wczytać uchwały: " + e.message;
    }
  }

  function renderDrawerHead(data) {
    const d = data.doc;
    learnSchemes([d]);
    $("dTitle").textContent = fmtDate(d.label);
    const b = $("dBadges"); b.textContent = "";
    b.append(...[outcomeBadge(d.outcome, d.outcome_label), d.scheme_type ? h("span", { class: "badge scheme", title: d.scheme_type_name || "" }, `${d.scheme_type}${d.scheme_type_name ? " – " + d.scheme_type_name : ""}`) : null,
      d.dissent_noted ? h("span", { class: "badge dissent" }, "zdania odrębne") : null].filter(Boolean));
    const m = $("dMeta"); m.textContent = "";
    const parts = [];
    if ((d.tax || []).length) parts.push(["Podatek", d.tax.join(", ")]);
    if ((d.tax_years || []).length) parts.push(["Lata", d.tax_years.join(", ")]);
    if (d.taxpayer_type) parts.push(["Podatnik", d.taxpayer_type]);
    if (d.request_basis) parts.push(["Podstawa wniosku", "art. " + d.request_basis]);
    if (d.proceeding) parts.push(["Postępowanie", d.proceeding]);
    parts.forEach(([k, v]) => m.append(h("span", { class: "meta-i" }, h("span", { class: "meta-k" }, k + ": "), v)));
    if (d.pdf_url) m.append(h("a", { class: "meta-i", href: d.pdf_url, target: "_blank", rel: "noopener noreferrer" }, "PDF na gov.pl ↗"));
    if (d.scheme_summary) {
      m.append(h("details", { class: "scheme-sum" }, h("summary", null, "Opis zespołu czynności"), h("p", null, d.scheme_summary),
        d.tax_benefit_mechanism ? h("p", { class: "muted" }, "Korzyść podatkowa: " + d.tax_benefit_mechanism) : null));
    }
  }

  function updateRecInfo() {
    const box = $("dRecInfo"); box.textContent = "";
    const r = drawer.data && state.rec ? drawer.data.records.find((x) => recToken(x.id) === state.rec) : null;
    if (!r) return;
    const w = r.part === "operative" ? "opinia" : r.part === "preamble" ? "nagłówek" : r.pkt != null ? `pkt ${r.pkt}` : "akapit";
    box.append(h("span", null, h("span", { class: "ri-k" }, "Wybrano: "), w + " "), h("button", { type: "button", class: "icon-btn small", "aria-label": "Odznacz punkt", onclick: () => nav({ rec: "" }) }, "×"));
  }

  function showView(initial) {
    if (!drawer.data) return;
    const pdf = state.view === "pdf";
    $("vHtml").setAttribute("aria-pressed", String(!pdf)); $("vPdf").setAttribute("aria-pressed", String(pdf));
    $("pageInd").hidden = !pdf;
    updateRecInfo();
    teardownPdf();
    if (pdf) renderPdfView(); else renderHtmlView();
  }

  // ----- HTML view -----
  function linkFootnotes(html, fnSet) {
    return html.replace(/\[(\d{1,3})\]/g, (m, n) => (fnSet.has(+n) ? `<a class="fnref" href="#fn-${n}" data-fn="${n}">[${n}]</a>` : m));
  }
  function renderHtmlView() {
    const { doc, records, footnotes, cites, cited_by, series, citations_other } = drawer.data;
    const fnSet = new Set((footnotes || []).map((f) => f.n));
    const body = h("div", { class: "doc-body" });
    const toc = [];
    let path = [], reasoningStarted = false, secN = 0;
    const flow = h("div", { class: "flow" });
    if (doc.text_source === "tesseract") flow.append(h("div", { class: "ocr-note" }, "Tekst ze skanu (OCR) – przy cytowaniu sprawdź w PDF"));
    const actions = (r) => h("span", { class: "rec-actions" },
      h("button", { type: "button", class: "mini", onclick: () => copyText(citation(doc, r)) }, "kopiuj cytat"),
      h("button", { type: "button", class: "mini", onclick: () => nav({ rec: recToken(r.id), view: "pdf" }) }, "pokaż w PDF"));
    const meta = (r) => (r.role || (r.warunki || []).length) ? h("div", { class: "rec-meta" }, r.role ? h("span", { class: "tag" }, r.role) : null, ...(r.warunki || []).map((w) => h("span", { class: "tag w" }, w))) : null;
    for (const r of records) {
      const tok = recToken(r.id);
      const text = h("div", { class: "rec-text", html: linkFootnotes(r.html || "", fnSet) });
      if (r.part === "preamble") {
        flow.append(h("div", { class: "rec preamble", id: "rec-" + tok, "data-rec": tok }, h("div", { class: "part-lab" }, "Nagłówek uchwały"), text, actions(r)));
      } else if (r.part === "operative") {
        flow.append(h("div", { class: "rec operative", id: "rec-" + tok, "data-rec": tok }, h("div", { class: "part-lab" }, "Opinia"), text, actions(r)));
        toc.push({ id: "rec-" + tok, text: "Opinia", lvl: 0 });
      } else if (r.part === "reasoning" || r.part === "note" || r.part === "signature") {
        if (r.part === "reasoning" && !reasoningStarted) {
          reasoningStarted = true;
          const id = "sec-" + (++secN);
          flow.append(h("h2", { class: "sec uzas", id }, "Uzasadnienie"));
          toc.push({ id, text: "Uzasadnienie", lvl: 0 });
        }
        const sp = r.section_path || [];
        if (r.part === "reasoning") {
          let diff = false;
          sp.forEach((s, i) => {
            if (diff || path[i] !== s) {
              diff = true;
              const id = "sec-" + (++secN);
              flow.append(h(i === 0 ? "h3" : "h4", { class: "sec", id }, s));
              toc.push({ id, text: s, lvl: i + 1 });
            }
          });
          path = sp;
        }
        const cls = "rec " + (r.part === "reasoning" ? "reasoning" : r.part);
        flow.append(h("div", { class: cls, id: "rec-" + tok, "data-rec": tok },
          h("div", { class: "num" }, r.pkt != null ? r.pkt + "." : ""),
          h("div", { class: "rec-main" }, text, meta(r), actions(r))));
      }
    }
    if ((footnotes || []).length) {
      const id = "sec-fn";
      flow.append(h("h2", { class: "sec", id }, "Przypisy"),
        h("ol", { class: "footnotes" }, footnotes.map((f) => h("li", { id: "fn-" + f.n, value: f.n }, f.text, f.page ? h("span", { class: "muted" }, ` (s. ${f.page})`) : null))));
      toc.push({ id, text: "Przypisy", lvl: 0 });
    }
    // relations
    const rel = h("div", { class: "relations" });
    const link = (x) => h("li", null, h("button", { type: "button", class: "link", onclick: () => nav({ doc: x.id, rec: "" }) }, fmtDate(x.label)));
    if ((cites || []).length) rel.append(h("section", null, h("h3", null, "Cytuje"), h("ul", null, cites.map(link))));
    if ((cited_by || []).length) rel.append(h("section", null, h("h3", null, "Cytowana przez"), h("ul", null, cited_by.map(link))));
    if ((series || []).length > 1 || (series || []).some((s) => s.id !== doc.id)) rel.append(h("section", null, h("h3", null, "Seria"), h("ul", null, series.map((s) => s.id === doc.id ? h("li", null, fmtDate(s.label), h("span", { class: "muted" }, " (ta uchwała)")) : link(s)))));
    const other = h("section", { class: "other" });
    for (const [k, name] of Object.entries(OTHER_NAME)) {
      const arr = (citations_other || {})[k] || [];
      if (!arr.length) continue;
      const m = new Map();
      arr.forEach((c) => { const e = m.get(c.target) || { n: 0, from: [] }; e.n++; if (!e.from.includes(c.from)) e.from.push(c.from); m.set(c.target, e); });
      other.append(h("h4", null, name), h("ul", null, [...m].map(([t, e]) => h("li", null, t,
        e.n > 1 ? h("span", { class: "muted" }, ` ×${e.n}`) : null, " ",
        ...e.from.map((f) => h("button", { type: "button", class: "link tiny", title: "Przejdź do punktu", onclick: () => nav({ rec: recToken(f) }) }, "pkt " + (recToken(f).match(/^\d+$/) ? recToken(f) : "→"))))
      )));
    }
    if (other.children.length) { other.prepend(h("h3", null, "Orzecznictwo i dokumenty")); rel.append(other); }
    flow.append(rel);

    const nav_ = h("details", { class: "toc" }, h("summary", { class: "toc-t" }, "Spis treści"),
      h("nav", { class: "toc-list", "aria-label": "Spis treści uchwały" },
        toc.map((t) => h("a", { href: "#" + t.id, class: "toc-i l" + t.lvl, title: t.text, onclick: (e) => {
          e.preventDefault(); const el = document.getElementById(t.id);
          if (!mqToc.matches) nav_.open = false;
          if (el) el.scrollIntoView({ block: "start" });
        } }, t.text))));
    body.append(nav_, flow);
    $("dBody").textContent = ""; $("dBody").append(body);
    syncDetails();
    $("dBody").scrollTop = 0;
    flow.addEventListener("click", (e) => {
      const a = e.target.closest("a.fnref");
      if (a) { e.preventDefault(); const t = document.getElementById("fn-" + a.dataset.fn); if (t) { t.scrollIntoView({ block: "center" }); flash(t); } }
    });
    scrollToRec(true);
  }
  function flash(el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2600); }
  function scrollToRec(noop) {
    $("dBody").querySelectorAll(".rec.sel").forEach((e) => e.classList.remove("sel"));
    if (!state.rec) return;
    const el = document.getElementById("rec-" + state.rec);
    if (!el) return;
    el.classList.add("sel");
    el.scrollIntoView({ block: "center" });
    flash(el);
  }

  // ----- PDF view -----
  const pdfCache = new Map();
  function teardownPdf() {
    if (drawer.io) { drawer.io.disconnect(); drawer.io = null; }
    drawer.pdf = null;
  }
  const boxCache = new Map();
  async function fetchBoxes(recId) {
    if (boxCache.has(recId)) return boxCache.get(recId);
    try { const d = await getJSON("/api/boxes/" + encodeURIComponent(recId)); boxCache.set(recId, d); return d; }
    catch { return null; }
  }
  async function renderPdfView() {
    const tok = drawer.token, id = drawer.doc;
    const scroller = $("dBody"); scroller.textContent = "";
    if (typeof pdfjsLib === "undefined") { scroller.append(h("p", { class: "empty" }, "Nie udało się załadować pdf.js (brak połączenia z cdnjs?). Użyj linku „PDF na gov.pl”.")); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_CDN;
    const wrap = h("div", { class: "pdf-wrap" }, h("p", { class: "muted pdf-load" }, "Ładuję PDF…"));
    scroller.append(wrap);
    let pdf = pdfCache.get(id);
    try {
      if (!pdf) { pdf = await pdfjsLib.getDocument({ url: window.STATIC_API ? window.STATIC_API.pdfUrl(id) : "/api/pdf/" + encodeURIComponent(id) }).promise; pdfCache.set(id, pdf); }
      if (tok !== drawer.token || state.view !== "pdf") return;
      const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
      if (tok !== drawer.token || state.view !== "pdf") return;
      wrap.textContent = "";
      const els = pages.map((pg, i) => {
        const vp = pg.getViewport({ scale: 1 });
        const el = h("div", { class: "pdf-page", "data-n": i + 1, style: `aspect-ratio:${vp.width}/${vp.height}` }, h("div", { class: "pdf-ph" }, `Strona ${i + 1}`));
        wrap.append(el); return el;
      });
      drawer.pdf = { pdf, pages, els, scroller, wrap };
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rendered = new Set();
      const P = drawer.pdf; P.rendered = rendered; P.gen = 0; P.ratio = 0;
      drawer.io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) {
          const el = en.target, n = +el.dataset.n;
          if (rendered.has(n)) continue; rendered.add(n);
          const gen = P.gen;
          const pg = pages[n - 1], vp0 = pg.getViewport({ scale: 1 });
          const scale = (el.clientWidth / vp0.width) * dpr;
          const vp = pg.getViewport({ scale });
          const cv = document.createElement("canvas"); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
          pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise.then(() => {
            if (tok !== drawer.token || gen !== P.gen) return;
            el.querySelector(".pdf-ph")?.remove(); el.querySelectorAll("canvas").forEach((c) => c.remove()); el.prepend(cv);
          }).catch(() => rendered.delete(n));
        }
      }, { root: scroller, rootMargin: "1500px 0px" });
      els.forEach((e) => drawer.io.observe(e));
      scroller.onscroll = updatePageInd;
      lastPdfW = scroller.clientWidth;
      await applyBoxes();
      updatePageInd();
    } catch (e) {
      if (tok === drawer.token) { wrap.textContent = ""; wrap.append(h("p", { class: "empty" }, "Nie udało się wczytać PDF: " + e.message)); }
    }
  }
  async function applyBoxes() {
    const P = drawer.pdf; if (!P) return;
    P.els.forEach((e) => e.querySelectorAll(".pdf-hl").forEach((x) => x.remove()));
    const scroller = P.scroller;
    if (!state.rec) { scroller.scrollTop = 0; return; }
    const tok = drawer.token;
    const data = await fetchBoxes(drawer.doc + "#" + state.rec);
    if (tok !== drawer.token || drawer.pdf !== P) return;
    if (!data || !(data.boxes || []).length) { toast("Brak współrzędnych tego fragmentu w PDF"); scroller.scrollTop = 0; return; }
    let first = null;
    for (const b of data.boxes) {
      const el = P.els[b.page - 1]; if (!el) continue;
      for (const [x0, y0, x1, y1] of b.rects) {
        const px = 0.004, py = 0.002;
        const r = h("div", { class: "pdf-hl", style: `left:${(Math.max(0, x0 - px) * 100).toFixed(3)}%;top:${(Math.max(0, y0 - py) * 100).toFixed(3)}%;width:${((x1 - x0 + 2 * px) * 100).toFixed(3)}%;height:${((y1 - y0 + 2 * py) * 100).toFixed(3)}%` });
        el.append(r);
        if (!first) first = { el, y0 };
      }
    }
    if (first) {
      const sr = scroller.getBoundingClientRect(), pr = first.el.getBoundingClientRect();
      const y = pr.top - sr.top + scroller.scrollTop + first.y0 * pr.height;
      scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
    }
  }
  function updatePageInd() {
    const P = drawer.pdf; if (!P) return;
    const sr = P.scroller.getBoundingClientRect(), mid = sr.top + sr.height / 2;
    let cur = 1;
    for (const el of P.els) { const r = el.getBoundingClientRect(); if (r.top <= mid) cur = +el.dataset.n; else break; }
    $("pageInd").textContent = `Strona ${cur} / ${P.els.length}`;
    P.ratio = P.scroller.scrollTop / (P.scroller.scrollHeight || 1);
  }
  // width change (rotation, window resize): re-render visible pages at the new width so the text stays sharp
  let lastPdfW = 0, resizeT;
  function redrawPdf() {
    const P = drawer.pdf; if (!P || !drawer.io) return;
    const w = P.scroller.clientWidth;
    if (!w || Math.abs(w - lastPdfW) < 2) return;
    lastPdfW = w; P.gen++; P.rendered.clear();
    P.scroller.scrollTop = P.ratio * P.scroller.scrollHeight;
    P.els.forEach((e) => { drawer.io.unobserve(e); drawer.io.observe(e); });
  }
  new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(redrawPdf, 200); }).observe($("dBody"));

  // ---------- apply state ----------
  let applied = { doc: "", rec: "", view: "html" };
  const mqPh = window.matchMedia("(max-width: 599.98px)");
  mqPh.addEventListener("change", () => renderControls());
  function renderControls() {
    $("mWords").setAttribute("aria-pressed", String(!state.sem)); $("mSem").setAttribute("aria-pressed", String(state.sem));
    $("semHint").hidden = !state.sem; $("lexHint").hidden = state.sem;
    $("rerank").checked = state.rerank;
    $("q").placeholder = !state.sem ? "np. \"czynność odpowiednia\"" : mqPh.matches ? "opisz zagadnienie własnymi słowami" : "opisz zagadnienie własnymi słowami, np. przeniesienie znaku towarowego do spółki zależnej i licencja zwrotna";
    $("gDoc").setAttribute("aria-pressed", String(state.group === "doc")); $("gPara").setAttribute("aria-pressed", String(state.group === "para"));
    const es = effSort();
    document.querySelectorAll("#sortSeg button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.sort === es));
      if (b.dataset.sort === "rel") { b.disabled = !state.q; b.title = state.q ? "" : "Trafność dotyczy tylko wyszukiwania ze słowami"; }
      else { b.disabled = semActive(); b.title = semActive() ? "W trybie „Znaczenie” wyniki są sortowane wg trafności" : ""; }
    });
  }
  function apply() {
    const s = parseHash();
    Object.assign(state, s);
    if (document.activeElement !== $("q") && $("q").value !== s.q) $("q").value = s.q;
    renderControls();
    const key = searchKey(s);
    if (key !== lastKey) { lastKey = key; runSearch(false); }
    if (!s.doc) { closeDrawerShell(); }
    else if (drawer.doc !== s.doc || $("drawer").hidden) { openDoc(s.doc); }
    else {
      if (applied.view !== s.view) showView();
      else if (applied.rec !== s.rec) {
        updateRecInfo();
        if (s.view === "pdf") applyBoxes(); else scrollToRec();
      }
    }
    applied = { doc: s.doc, rec: s.rec, view: s.view };
  }

  // ---------- modal: syntax help + shortcuts ----------
  const modal = { lastFocus: null, built: false };
  const isModalOpen = () => !$("modal").hidden;
  function buildModal() {
    if (modal.built) return; modal.built = true;
    const ex = (q) => h("button", { type: "button", class: "ex", title: "Uruchom to wyszukiwanie", onclick: () => { closeModal(true); runQuery(q); } }, q);
    const row = (op, what, ...ex_) => h("tr", null, h("td", null, h("code", null, op)), h("td", null, what), h("td", { class: "exs" }, ...ex_.map(ex)));
    const kb = (k, what) => h("tr", null, h("td", null, h("kbd", null, k)), h("td", null, what));
    $("mBody").append(
      h("p", { class: "muted" }, "Kliknij przykład, aby go uruchomić."),
      h("div", { class: "tbl-wrap" }, h("table", { class: "ref" },
        h("thead", null, h("tr", null, h("th", null, "Operator"), h("th", null, "Znaczenie"), h("th", null, "Przykład"))),
        h("tbody", null,
          row("słowa (spacja), AND", "wszystkie słowa w jednym punkcie (domyślnie)", "znak towarowy"),
          row("\"fraza\"", "dokładna fraza, w podanej kolejności", "\"czynność odpowiednia\""),
          row("OR", "którekolwiek ze słów", "fundacja OR darowizna"),
          row("NOT, -słowo", "wyklucza punkty z tym słowem", "znak towarowy NOT licencja", "znak towarowy -licencja"),
          row("słowo*", "początek wyrazu (sztuczny, sztuczność…)", "sztuczn*"),
          row("( )", "grupowanie operatorów", "(fundusz OR fundacja) AND \"vacatio legis\"")))),
      h("ul", { class: "help-notes" },
        h("li", null, h("strong", null, "Odmiana uwzględniona. "), "Słowa są sprowadzane do formy podstawowej: „czynności”, „czynnością” i „czynność” to to samo słowo."),
        h("li", null, h("strong", null, "Wszystkie słowa w jednym punkcie. "), "Zapytanie ", h("code", null, "znak towarowy"), " znajdzie punkty uchwały (lub opinię), w których występują oba słowa – nie uchwały, które zawierają je w różnych miejscach."),
        h("li", null, h("strong", null, "Operatory wielkimi literami. "), h("code", null, "AND"), ", ", h("code", null, "OR"), ", ", h("code", null, "NOT"), "; małymi literami to zwykłe słowa."),
        h("li", null, h("strong", null, "Komunikat „Żaden punkt nie zawiera wszystkich słów – pokazuję dowolne”"), " (", h("code", null, "relaxed_or"), "). Jeśli zwykłe zapytanie (bez operatorów) z kilku słów nie znalazło żadnego punktu ze wszystkimi słowami, wyszukiwarka pokazuje punkty z którymkolwiek z nich. Żeby wymusić wszystkie słowa, użyj ", h("code", null, "AND"), " albo cudzysłowu."),
        h("li", null, h("strong", null, "Filtry. "), "Kilka wartości w jednym filtrze to „lub”; dla Warunku i Instrumentów można przełączyć na „wszystkie”. Słupek roku: klik = ten rok, Shift+klik = rozszerz zakres.")),
      h("h3", null, "Dwa tryby: Słowa i Znaczenie"),
      h("ul", { class: "help-notes" },
        h("li", null, h("strong", null, "Słowa. "), "Dosłowne wyszukiwanie po wyrazach (z odmianą) i operatorami opisanymi wyżej; działa w przeglądarce."),
        h("li", null, h("strong", null, "Znaczenie. "), "Szuka punktów podobnych treścią do opisanego zagadnienia, także gdy nie mają tych samych słów (wyszukiwanie semantyczne połączone ze słowami, Voyage AI). Wpisz zdanie własnymi słowami; operatory (", h("code", null, "OR"), ", ", h("code", null, "-słowo"), ", cudzysłów) tu nie działają. „Dokładniej (rerank)” dodatkowo porządkuje najlepsze wyniki – wolniej, ale trafniej. Wyniki są sortowane wg trafności. Bez wpisanego zapytania przeglądasz uchwały jak w trybie Słowa.")),
      h("h3", null, "Skróty klawiaturowe"),
      h("div", { class: "tbl-wrap" }, h("table", { class: "ref" }, h("tbody", null,
        kb("/", "przejdź do pola wyszukiwania"), kb("?", "ta pomoc (składnia i skróty)"), kb("Esc", "zamknij okno, panel uchwały lub filtry"),
        kb("g", "przełącz widok Uchwały / Punkty"), kb("↑ ↓ Enter", "wybór z ostatnich wyszukiwań"))))
    );
  }
  function openModal() {
    buildModal();
    if (!isModalOpen()) { modal.lastFocus = document.activeElement; $("modal").hidden = false; $("modalBack").hidden = false; document.body.classList.add("noscroll"); }
    $("mClose").focus();
  }
  function closeModal(noFocus) {
    if (!isModalOpen()) return;
    $("modal").hidden = true; $("modalBack").hidden = true;
    if ($("drawer").hidden && !$("sidebar").classList.contains("open")) document.body.classList.remove("noscroll");
    if (!noFocus && modal.lastFocus && modal.lastFocus.focus) try { modal.lastFocus.focus(); } catch {}
  }

  // ---------- recent searches dropdown ----------
  const recent = { idx: -1, items: [] };
  function renderRecent() {
    const box = $("recent"), t = $("q").value.trim().toLowerCase();
    recent.items = getRecent().filter((x) => !t || (x.toLowerCase().includes(t) && x.toLowerCase() !== t));
    recent.idx = -1; box.textContent = "";
    if (!recent.items.length) { closeRecent(); return; }
    box.append(h("div", { class: "recent-h" }, h("span", null, "Ostatnie wyszukiwania"),
      h("button", { type: "button", class: "link tiny", onclick: () => { ls.del(RECENT_KEY); closeRecent(); toast("Wyczyszczono historię"); } }, "wyczyść historię")));
    recent.items.forEach((x, i) => box.append(h("div", { class: "recent-i", role: "option", id: "rec-opt-" + i, "aria-selected": "false",
      onmousedown: (e) => e.preventDefault(), onclick: () => runQuery(x) }, x)));
    box.hidden = false; $("q").setAttribute("aria-expanded", "true");
  }
  function closeRecent() { $("recent").hidden = true; $("q").setAttribute("aria-expanded", "false"); $("q").removeAttribute("aria-activedescendant"); recent.idx = -1; }
  function moveRecent(d) {
    const n = recent.items.length; if (!n) return;
    recent.idx = ((recent.idx + 1 + d + n + 1) % (n + 1)) - 1;  // -1 = none
    $("recent").querySelectorAll(".recent-i").forEach((el, i) => { el.classList.toggle("on", i === recent.idx); el.setAttribute("aria-selected", String(i === recent.idx)); });
    if (recent.idx >= 0) $("q").setAttribute("aria-activedescendant", "rec-opt-" + recent.idx); else $("q").removeAttribute("aria-activedescendant");
  }

  // ---------- tools: export, link, theme, menu ----------
  const trim600 = (t) => { t = (t || "").replace(/\s+/g, " ").trim(); if (t.length <= 600) return t; const c = t.slice(0, 600), i = c.lastIndexOf(" "); return c.slice(0, i > 400 ? i : 600) + "…"; };
  const pageBase = () => location.href.split("#")[0];
  function hitInfo(x) {
    const doc = x.doc_id, b = x.best || x, m = /rpuo-(\d{4})-(\d+)/.exec(doc) || [];
    const part = b.part, pkt = b.pkt, page = b.page;
    const where = part === "operative" ? "opinia" : pkt != null ? `pkt ${pkt}` : part === "preamble" ? "nagłówek" : page ? `s. ${page}` : "akapit";
    const cite = `Uchwała Rady do Spraw Przeciwdziałania Unikaniu Opodatkowania nr ${+m[2]}/${m[1]} z ${fmtDate(x.date)} r., ${where}`;
    const link = `${pageBase()}#doc=${encodeURIComponent(doc)}&rec=${encodeURIComponent(recToken(b.id))}`;
    const sc = x.scheme_type;
    return { doc, where, cite, link, date: fmtDate(x.date), outcome: OUTCOME_NAME[x.outcome] || x.outcome_label || x.outcome || "",
      scheme: sc ? (schemeNames[sc] ? `${sc} – ${schemeNames[sc]}` : sc) : "", role: b.role || "", text: trim600(b.text || "") };
  }
  const csvCell = (v) => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime }), a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function exportResults(kind) {
    closeTools(); toast("Przygotowuję eksport…");
    try {
      let d;
      if (semActive()) { const p = apiParams({ limit: 100, offset: 0 }); p.delete("sort"); p.set("mode", "hybrid"); if (state.rerank) p.set("rerank", "1"); d = await getSemantic(p); toast("Tryb „Znaczenie”: eksport obejmuje 100 najtrafniejszych wyników"); }
      else d = await getJSON("/api/search?" + apiParams({ limit: 10000, offset: 0 }));
      learnSchemes(d.hits);
      const rows = d.hits.map(hitInfo), stamp = new Date().toISOString().slice(0, 10);
      if (!rows.length) { toast("Brak wyników do eksportu"); return; }
      if (kind === "csv") {
        const head = ["uchwała", "data", "pkt/opinia", "rozstrzygnięcie", "schemat", "rola", "fragment", "link"];
        const lines = [head, ...rows.map((r) => [idLabel(r.doc), r.date, r.where, r.outcome, r.scheme, r.role, r.text, r.link])].map((l) => l.map(csvCell).join(";"));
        download(`opinie-rady-puo-${stamp}.csv`, "text/csv;charset=utf-8", "﻿" + lines.join("\r\n") + "\r\n");
      } else {
        const md = [`# Opinie Rady PUO – wyniki wyszukiwania`, "", `Zapytanie: ${state.q ? "`" + state.q + "`" : "(wszystkie)"}; wyników: ${rows.length}; stan na ${fmtDate(stamp)}.`, "",
          ...rows.map((r) => `- ${r.cite}: „${r.text}” ([link](${r.link}))`)];
        download(`opinie-rady-puo-${stamp}.md`, "text/markdown;charset=utf-8", md.join("\n") + "\n");
      }
      toast(`Wyeksportowano: ${rows.length}`);
    } catch (e) { toast(e.rate ? "Za dużo zapytań – spróbuj za minutę" : e.unavailable ? "Wyszukiwanie semantyczne jest chwilowo niedostępne" : "Błąd eksportu: " + e.message); }
  }
  const THEME_KEY = "rpuo.theme", THEMES = ["auto", "light", "dark"], THEME_NAME = { auto: "auto", light: "jasny", dark: "ciemny" };
  function applyTheme(t, persist) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else { t = "auto"; document.documentElement.removeAttribute("data-theme"); }
    if (persist) { if (t === "auto") ls.del(THEME_KEY); else ls.set(THEME_KEY, t); }
    $("tThemeS").textContent = "◐ " + THEME_NAME[t]; $("tThemeL").textContent = "Motyw: " + THEME_NAME[t];
    $("tTheme").setAttribute("aria-label", `Motyw: ${THEME_NAME[t]} (kliknij, aby zmienić)`); $("tTheme").title = `Motyw: ${THEME_NAME[t]} – kliknij, aby zmienić`;
    $("tTheme").dataset.theme = t;
  }
  const toolsOpen = () => $("tools").classList.contains("open");
  function closeTools(focusBtn) {
    $("tools").classList.remove("open"); $("toolsBtn").setAttribute("aria-expanded", "false");
    if (focusBtn) $("toolsBtn").focus();
  }

  // ---------- drawer width (desktop >= 1100px) ----------
  const DW_KEY = "rpuo.drawerw", mqWide = window.matchMedia("(min-width: 1100px)");
  const clampVw = (v) => Math.min(85, Math.max(40, v));
  function setDrawerW(vw, persist) {
    const d = $("drawer");
    if (vw == null) { d.classList.remove("custom"); d.style.removeProperty("--dw"); $("dResize").removeAttribute("aria-valuenow"); if (persist) ls.del(DW_KEY); return; }
    vw = clampVw(vw); d.classList.add("custom"); d.style.setProperty("--dw", vw.toFixed(2) + "vw"); $("dResize").setAttribute("aria-valuenow", String(Math.round(vw)));
    if (persist) ls.set(DW_KEY, vw.toFixed(2));
  }
  const curVw = () => ($("drawer").getBoundingClientRect().width / window.innerWidth) * 100;

  // ---------- init ----------
  const mqSheet = window.matchMedia("(min-width: 900px)");
  const typed = debounce(() => nav({ q: $("q").value.trim() }, true), 300);
  const typedSave = debounce(() => saveRecent($("q").value), 1500);
  $("q").addEventListener("input", () => { typed(); typedSave(); renderRecent(); });
  $("q").addEventListener("focus", renderRecent);
  $("q").addEventListener("click", () => { if ($("recent").hidden) renderRecent(); });
  $("q").addEventListener("keydown", (e) => {
    if ($("recent").hidden) { if (e.key === "ArrowDown") { renderRecent(); e.preventDefault(); } return; }
    if (e.key === "ArrowDown") { e.preventDefault(); moveRecent(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveRecent(-1); }
    else if (e.key === "Enter" && recent.idx >= 0) { e.preventDefault(); runQuery(recent.items[recent.idx]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRecent(); }
  });
  $("searchForm").addEventListener("focusout", (e) => { if (!e.relatedTarget || !$("searchForm").contains(e.relatedTarget)) closeRecent(); });
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); typed.cancel(); typedSave.cancel(); closeRecent(); const q = $("q").value.trim(); saveRecent(q); if (q === state.q) { lastKey = null; } nav({ q }, true); });
  $("mWords").addEventListener("click", () => nav({ sem: false }));
  $("mSem").addEventListener("click", () => nav({ sem: true }));
  $("rerank").addEventListener("change", (e) => { state.rerank = e.target.checked; ls.set(RERANK_KEY, state.rerank ? "1" : "0"); apply(); });
  $("gDoc").addEventListener("click", () => nav({ group: "doc" }));
  $("gPara").addEventListener("click", () => nav({ group: "para" }));
  $("sortSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]"); if (!b || b.disabled) return;
    nav({ sort: b.dataset.sort === "rel" ? "" : b.dataset.sort });
  });
  $("clearBtn").addEventListener("click", clearAll);
  $("moreBtn").addEventListener("click", () => runSearch(true));
  $("vHtml").addEventListener("click", () => nav({ view: "html" }));
  $("vPdf").addEventListener("click", () => nav({ view: "pdf" }));
  $("dClose").addEventListener("click", () => nav({ doc: "", rec: "" }));
  $("backdrop").addEventListener("click", () => nav({ doc: "", rec: "" }));
  const sidebar = (open) => {
    $("sidebar").classList.toggle("open", open); $("sidebarBackdrop").hidden = !open;
    document.body.classList.toggle("noscroll-sheet", open);
    $("filtersBtn").setAttribute("aria-expanded", String(open));
    if (open) $("sidebarClose").focus(); else if (document.activeElement && $("sidebar").contains(document.activeElement)) $("filtersBtn").focus();
  };
  $("applyBtn").addEventListener("click", () => sidebar(false));
  mqSheet.addEventListener("change", () => { if (!mqSheet.matches && $("sidebar").classList.contains("open")) sidebar(false); });
  $("filtersBtn").addEventListener("click", () => sidebar(!$("sidebar").classList.contains("open")));
  $("sidebarClose").addEventListener("click", () => sidebar(false));
  $("sidebarBackdrop").addEventListener("click", () => sidebar(false));

  // help / modal
  $("helpBtn").addEventListener("click", openModal); $("hintHelp").addEventListener("click", openModal);
  $("tHelp").addEventListener("click", () => { closeTools(); openModal(); });
  $("mClose").addEventListener("click", () => closeModal()); $("modalBack").addEventListener("click", () => closeModal());
  // sample queries on the empty state
  $("try").append(h("span", { class: "try-k" }, "Spróbuj: "), ...SAMPLES.map((q) => h("button", { type: "button", class: "ex", onclick: () => runQuery(q) }, q)));
  // tools
  $("toolsBtn").addEventListener("click", () => {
    const o = !toolsOpen(); $("tools").classList.toggle("open", o); $("toolsBtn").setAttribute("aria-expanded", String(o));
    if (o) $("tools").querySelector(".tool").focus();
  });
  $("tCsv").addEventListener("click", () => exportResults("csv"));
  $("tMd").addEventListener("click", () => exportResults("md"));
  $("tLink").addEventListener("click", () => { closeTools(); copyText(location.href, "Skopiowano link do wyszukiwania"); });
  $("tTheme").addEventListener("click", () => { const t = THEMES[(THEMES.indexOf($("tTheme").dataset.theme) + 1) % 3]; applyTheme(t, true); });
  document.addEventListener("click", (e) => { if (toolsOpen() && !e.target.closest("#tools, #toolsBtn")) closeTools(); });
  applyTheme(ls.get(THEME_KEY), false);

  // drawer resize
  const dr = $("dResize");
  { const saved = parseFloat(ls.get(DW_KEY)); if (isFinite(saved)) setDrawerW(saved, false); }
  dr.addEventListener("pointerdown", (e) => {
    if (!mqWide.matches) return;
    e.preventDefault(); dr.setPointerCapture(e.pointerId); document.body.classList.add("resizing");
    const mv = (ev) => setDrawerW(((window.innerWidth - ev.clientX) / window.innerWidth) * 100, false);
    const up = () => { dr.removeEventListener("pointermove", mv); dr.removeEventListener("pointerup", up); dr.removeEventListener("pointercancel", up); document.body.classList.remove("resizing"); setDrawerW(curVw(), true); };
    dr.addEventListener("pointermove", mv); dr.addEventListener("pointerup", up); dr.addEventListener("pointercancel", up);
  });
  dr.addEventListener("dblclick", () => setDrawerW(null, true));
  dr.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setDrawerW(curVw() + (e.key === "ArrowLeft" ? 2 : -2), true); }
    else if (e.key === "Enter") { e.preventDefault(); setDrawerW(null, true); }
  });

  function trapTab(e, root) {
    const f = [...root.querySelectorAll("a[href],button,input,summary,[tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  const typing = () => { const a = document.activeElement; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (isModalOpen()) { e.preventDefault(); closeModal(); }
      else if (toolsOpen()) { e.preventDefault(); closeTools(true); }
      else if (!$("drawer").hidden) { e.preventDefault(); nav({ doc: "", rec: "" }); }
      else if ($("sidebar").classList.contains("open")) sidebar(false);
    } else if (e.key === "Tab" && isModalOpen()) trapTab(e, $("modal"));
    else if (e.key === "Tab" && !$("drawer").hidden) trapTab(e, $("drawer"));
    else if (e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    else if (e.key === "/" && $("drawer").hidden && !isModalOpen()) { e.preventDefault(); $("q").focus(); }
    else if (e.key === "?" && !isModalOpen()) { e.preventDefault(); openModal(); }
    else if ((e.key === "g" || e.key === "G") && $("drawer").hidden && !isModalOpen() && !$("sidebar").classList.contains("open")) { e.preventDefault(); nav({ group: state.group === "doc" ? "para" : "doc" }); }
  });
  window.addEventListener("hashchange", apply);

  getJSON("/api/stats").then((s) => {
    $("stats").textContent = `Uchwał: ${s["uchwały"]} · punktów: ${s["punkty"]} · przypisów: ${s["przypisy"]} · cytowań: ${s["cytowania"]} · serii: ${s["serie"]} · od ${fmtDate(s.od)} do ${fmtDate(s.do)}`;
  }).catch(() => {});
  // learn scheme names for facet labels (independent of current query)
  getJSON("/api/search?limit=200&group=doc").then((d) => { learnSchemes(d.hits); if (results.d) { renderFacets(results.d.facets || {}); renderChips(); } }).catch(() => {});
  apply();
})();
