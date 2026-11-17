"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const LIMIT = 20;
  const FACETS = [
    ["outcome", "Rozstrzygnięcie"], ["scheme", "Schemat optymalizacyjny"], ["tax", "Podatek"],
    ["term", "Kadencja"], ["topic", "Temat"], ["role", "Rola punktu"], ["warunek", "Warunek"],
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

  // ---------- state & hash ----------
  const state = { q: "", group: "doc", filters: {}, doc: "", rec: "", view: "html" };
  function parseHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    const s = { q: p.get("q") || "", group: p.get("group") === "para" ? "para" : "doc", filters: {}, doc: p.get("doc") || "", rec: p.get("rec") || "", view: p.get("view") === "pdf" ? "pdf" : "html" };
    for (const k of FKEYS) if (p.get(k)) s.filters[k] = p.get(k);
    if (!s.doc) s.rec = "";
    return s;
  }
  function buildHash(s) {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    if (s.group === "para") p.set("group", "para");
    for (const k of FKEYS) if (s.filters[k]) p.set(k, s.filters[k]);
    if (s.doc) { p.set("doc", s.doc); if (s.rec) p.set("rec", s.rec); if (s.view === "pdf") p.set("view", "pdf"); }
    return p.toString();
  }
  // changes -> new hash; push (default) creates history entry; replace edits current
  function nav(changes, replace) {
    const next = { ...state, ...changes };
    if (changes.filters) next.filters = changes.filters;
    if (!next.doc) next.rec = "";
    const hash = buildHash(next);
    if (hash === location.hash.replace(/^#/, "")) { if (replace) apply(); return; }
    if (replace) { history.replaceState(null, "", "#" + hash); apply(); }
    else location.hash = hash; // hashchange -> apply
  }
  const searchKey = (s) => JSON.stringify([s.q, s.group, FKEYS.map((k) => s.filters[k] || "")]);

  // ---------- search ----------
  let results = { hits: [], total: 0, offset: 0 }, searchCtl = null, lastKey = null;
  async function runSearch(append) {
    if (searchCtl) searchCtl.abort();
    searchCtl = new AbortController();
    const offset = append ? results.hits.length : 0;
    const p = new URLSearchParams({ q: state.q, group: state.group, limit: LIMIT, offset });
    for (const k of FKEYS) if (state.filters[k]) p.set(k, state.filters[k]);
    if (!append) $("summary").textContent = "Szukam…";
    try {
      const d = await getJSON("/api/search?" + p, searchCtl.signal);
      learnSchemes(d.hits);
      if (append) { results.hits = results.hits.concat(d.hits); }
      else { results = { hits: d.hits, offset: 0 }; }
      results.d = d;
      renderResults(append ? d.hits : null);
      renderFacets(d.facets || {});
      renderChips();
    } catch (e) {
      if (e.name !== "AbortError") $("summary").textContent = "Błąd wyszukiwania: " + e.message;
    }
  }

  function renderChips() {
    const box = $("chips"); box.textContent = "";
    for (const k of FKEYS) if (state.filters[k]) {
      const title = FACETS.find((f) => f[0] === k)[1];
      box.append(h("button", { class: "chip", type: "button", "aria-label": `Usuń filtr ${title}: ${facetValueLabel(k, state.filters[k])}`, onclick: () => setFilter(k, state.filters[k]) },
        h("span", { class: "chip-k" }, title + ": "), facetValueLabel(k, state.filters[k]), h("span", { "aria-hidden": "true" }, " ×")));
    }
    const nf = Object.keys(state.filters).length;
    $("clearBtn").hidden = !nf;
    $("filtersBtn").textContent = nf ? `Filtry (${nf})` : "Filtry";
  }
  function setFilter(k, v) {
    const f = { ...state.filters };
    if (f[k] === v) delete f[k]; else f[k] = v;
    nav({ filters: f }, true);
  }

  function renderFacets(facets) {
    const box = $("facets"); box.textContent = "";
    for (const [k, title] of FACETS) {
      const data = { ...(facets[k] || {}) };
      const active = state.filters[k];
      if (active && !(active in data)) data[active] = 0;
      let keys = Object.keys(data);
      if (!keys.length) continue;
      if (k === "scheme" || k === "term") keys.sort();
      else keys.sort((a, b) => data[b] - data[a] || a.localeCompare(b, "pl"));
      const det = h("details", { class: "facet", open: true }, h("summary", null, title));
      const ul = h("ul", { class: "facet-list" });
      for (const v of keys) {
        ul.append(h("li", null, h("button", { type: "button", class: "facet-item" + (active === v ? " on" : ""), "aria-pressed": active === v ? "true" : "false", title: facetValueLabel(k, v), onclick: () => setFilter(k, v) },
          h("span", { class: "fl" }, facetValueLabel(k, v)), h("span", { class: "fc" }, String(data[v])))));
      }
      det.append(ul); box.append(det);
    }
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
    $("summary").textContent = (para ? `Punkty: ${d.total_unique ?? d.total_paragraphs}` + (d.total_unique != null && d.total_unique !== d.total_paragraphs ? ` (z powtórzeniami w seriach ${d.total_paragraphs})` : "") : `Uchwały: ${d.total_groups ?? d.total_docs}` + (d.total_docs != null && d.total_groups != null && d.total_docs !== d.total_groups ? ` (w seriach łącznie ${d.total_docs})` : "") + `, punkty z trafieniem: ${d.total_paragraphs}`) + (browse ? " · przeglądanie, od najnowszej" : "");
    const n = $("notice");
    n.hidden = !d.relaxed_or;
    n.textContent = d.relaxed_or ? "Żaden punkt nie zawiera wszystkich słów – pokazuję dowolne." : "";
    if (!results.hits.length) box.append(h("p", { class: "empty" }, "Brak wyników. Spróbuj mniej słów albo usuń filtry."));
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
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); }
    catch { const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = t; document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); }
    toast("Skopiowano cytat");
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
  function apply() {
    const s = parseHash();
    Object.assign(state, s);
    if (document.activeElement !== $("q") && $("q").value !== s.q) $("q").value = s.q;
    $("gDoc").setAttribute("aria-pressed", String(s.group === "doc")); $("gPara").setAttribute("aria-pressed", String(s.group === "para"));
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

  // ---------- init ----------
  const mqSheet = window.matchMedia("(min-width: 900px)");
  const typed = debounce(() => nav({ q: $("q").value.trim() }, true), 300);
  $("q").addEventListener("input", typed);
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); typed.cancel(); const q = $("q").value.trim(); if (q === state.q) { lastKey = null; } nav({ q }, true); });
  $("gDoc").addEventListener("click", () => nav({ group: "doc" }, true));
  $("gPara").addEventListener("click", () => nav({ group: "para" }, true));
  $("clearBtn").addEventListener("click", () => nav({ filters: {} }, true));
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("drawer").hidden) { e.preventDefault(); nav({ doc: "", rec: "" }); }
      else if ($("sidebar").classList.contains("open")) sidebar(false);
    } else if (e.key === "Tab" && !$("drawer").hidden) {
      const f = [...$("drawer").querySelectorAll("a[href],button,input,summary,[tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!$("drawer").contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && $("drawer").hidden) { e.preventDefault(); $("q").focus(); }
  });
  window.addEventListener("hashchange", apply);

  getJSON("/api/stats").then((s) => {
    $("stats").textContent = `Uchwał: ${s["uchwały"]} · punktów: ${s["punkty"]} · przypisów: ${s["przypisy"]} · cytowań: ${s["cytowania"]} · serii: ${s["serie"]} · od ${fmtDate(s.od)} do ${fmtDate(s.do)}`;
  }).catch(() => {});
  // learn scheme names for facet labels (independent of current query)
  getJSON("/api/search?limit=200&group=doc").then((d) => { learnSchemes(d.hits); if (results.d) { renderFacets(results.d.facets || {}); renderChips(); } }).catch(() => {});
  apply();
})();
