"use strict";
/* Przewodnik po wyszukiwarce: reflektor na elemencie + dymek z opisem (Wstecz / Dalej / Pomiń, ← → Esc).
   Własny stan aplikacji (arkusz filtrów, menu narzędzi, panel uchwały, hash) tour otwiera i zamyka sam
   i po zakończeniu przywraca. Pierwsza wizyta: mała propozycja, zapamiętana w localStorage. */
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = "rpuo.tour";
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); } };
  const mqPhone = window.matchMedia("(max-width: 640px)");
  const mqNarrow = window.matchMedia("(max-width: 899.98px)");
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const toolsInline = () => !shown($("toolsBtn"));  // >= 1400px: the tools sit in the header

  const q = (sel) => document.querySelector(sel);
  const STEPS = [
    { t: "Witamy", x: "To wyszukiwarka 74 uchwał Rady PUO. Przeszukujesz je punkt po punkcie uzasadnienia, więc wynik wskazuje fragment, który można zacytować. Przewodnik zajmie pół minuty." },
    { t: "Pole wyszukiwania", target: () => [$("searchForm")],
      x: "Wpisz słowa – odmiana jest uwzględniona. „fraza” w cudzysłowie szuka dosłownie, OR łączy alternatywy, NOT lub -słowo wyklucza, a sztuczn* zastępuje końcówkę. Przycisk ? pokazuje pełną składnię." },
    { t: "Słowa albo Znaczenie", target: () => [q('[aria-label="Tryb wyszukiwania"]')],
      x: "Słowa szukają dosłownie. Znaczenie to wyszukiwanie semantyczne: opisz zagadnienie własnymi słowami, a znajdziesz też punkty, w których nie ma tych samych wyrazów." },
    { t: "Uchwały albo Punkty", target: () => [q('[aria-label="Rodzaj wyników"]')],
      x: "Uchwały grupują wyniki według uchwały, a serie podobnych uchwał są zwinięte w jedną pozycję. Punkty pokazują pojedyncze punkty uzasadnienia." },
    { t: "Wykres lat", needs: ["sheet"], alignTop: true, target: () => [$("facets").querySelector(".histo")],
      x: "Kliknij słupek, by zawęzić wyniki do jednego roku. Shift+klik rozszerza zakres o kolejne lata." },
    { t: "Filtry", needs: ["sheet"], dock: "top", alignTop: true, target: () => [...$("facets").querySelectorAll("[data-facet]")],
      x: "Zawęź wyniki według rozstrzygnięcia, schematu optymalizacyjnego, warunku lub instrumentów. Przy warunku i instrumentach wybierz, czy uchwała ma mieć którykolwiek, czy wszystkie zaznaczone." },
    { t: "Wynik", alignTop: true, target: () => [q("#results .card:has(.series-btn)") || q("#results .card")],
      x: "Plakietki pokazują rozstrzygnięcie i schemat optymalizacyjny, a „seria × N” rozwija pozostałe uchwały serii. Fragment z podświetlonym trafieniem otworzy uchwałę w tym miejscu – kliknij go." },
    { t: "Uchwała w panelu", needs: ["drawer"], target: () => [q("#drawer .dh-bar")],
      x: "HTML to tekst do czytania. PDF otwiera się na właściwej stronie i podświetla fragment. Przy punkcie „kopiuj cytat” wkłada do schowka gotowy cytat." },
    { t: "Narzędzia", needs: ["tools"], target: () => [$("tools")],
      x: () => (toolsInline()
        ? "Eksport wyników do CSV lub Markdown, link do bieżącego wyszukiwania i zmiana motywu. Klawisz ? pokazuje skróty klawiszowe."
        : "Przycisk ⋯ otwiera eksport wyników do CSV lub Markdown, link do bieżącego wyszukiwania, zmianę motywu i skróty klawiszowe (też pod klawiszem ?).") },
    { t: "Serwer MCP – uchwały w Twoim asystencie AI", target: () => [$("mcpBtn")],
      x: "Te same wyszukiwanie i dosłowne punkty z pinpointem są dostępne dla Claude jako serwer MCP – asystent przeszukuje uchwały i cytuje je wprost ze źródła. Jak to podłączyć, opisuje przycisk „MCP” w stopce." },
    { t: "To wszystko", x: "Przewodnik uruchomisz ponownie przyciskiem „Przewodnik” w nagłówku. Miłego szukania." },
  ];

  let active = false, idx = 0, token = 0, root, spot, block, pop, els = [], cur = [], quiet = false, pushes = 0, saved = null, lastFocus = null, settleUntil = 0, raf = 0;

  // ---------- helpers: scrolling, geometry ----------
  function scrollerOf(el, mustScroll) {
    for (let p = el && el.parentElement; p && p !== document.documentElement && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === "auto" || o === "scroll") && (!mustScroll || p.scrollHeight > p.clientHeight + 1)) return p;
    }
    return null;
  }
  function rectOf(list) {
    if (!list.length) return null;
    let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    for (const e of list) { const g = e.getBoundingClientRect(); l = Math.min(l, g.left); t = Math.min(t, g.top); r = Math.max(r, g.right); b = Math.max(b, g.bottom); }
    let cl = 0, ct = 0, cr = innerWidth, cb = innerHeight;
    const sc = scrollerOf(list[0]);
    if (sc) { const g = sc.getBoundingClientRect(); cl = Math.max(cl, g.left); ct = Math.max(ct, g.top); cr = Math.min(cr, g.right); cb = Math.min(cb, g.bottom); }
    l = Math.max(l, cl); t = Math.max(t, ct); r = Math.min(r, cr); b = Math.min(b, cb);
    return r > l && b > t ? { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t } : null;
  }
  function reveal(list, s) {
    const first = list[0];
    if (!first) return;
    const sc = scrollerOf(first, true);
    let zt = 8, zb = innerHeight - 8;
    if (mqPhone.matches) { const ph = pop.offsetHeight + 16; if (s.dock === "top") zt = ph; else zb = innerHeight - ph; }
    else { const top = q(".top"); if (top && getComputedStyle(top).position === "sticky") zt = top.getBoundingClientRect().bottom + 8; }
    if (sc) { const g = sc.getBoundingClientRect(); zt = Math.max(zt, g.top); zb = Math.min(zb, g.bottom); }
    const a = first.getBoundingClientRect(), last = list[list.length - 1].getBoundingClientRect();
    const top = a.top, bottom = Math.max(last.bottom, a.bottom);
    let d = 0;
    if (s.alignTop || top < zt) d = top - zt;
    else if (bottom > zb) d = Math.min(bottom - zb, top - zt);
    if (!d) return;
    if (sc) sc.scrollTop += d; else window.scrollBy(0, d);
  }

  // ---------- placement ----------
  function update() {
    if (!active) return;
    const r = rectOf(cur), phone = mqPhone.matches;
    block.classList.toggle("dim", !r);
    if (r) {
      const g = 5;
      Object.assign(spot.style, { display: "block", left: r.left - g + "px", top: r.top - g + "px", width: r.width + 2 * g + "px", height: r.height + 2 * g + "px" });
    } else spot.style.display = "none";
    if (phone) { pop.style.left = pop.style.top = ""; return; }
    const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight, m = 10, g = 16;
    let L, T;
    if (!r) { L = (vw - pw) / 2; T = (vh - ph) / 2; }
    else {
      const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const cands = [
        [cl(r.left, m, vw - pw - m), r.bottom + g], [cl(r.left, m, vw - pw - m), r.top - ph - g],
        [r.right + g, cl(r.top, m, vh - ph - m)], [r.left - pw - g, cl(r.top, m, vh - ph - m)],
      ];
      const ok = cands.find(([x, y]) => x >= m && y >= m && x + pw <= vw - m && y + ph <= vh - m);
      [L, T] = ok || [vw - pw - m, vh - ph - m];
    }
    pop.style.left = Math.round(L) + "px"; pop.style.top = Math.round(T) + "px";
  }
  const kick = () => { clearTimeout(raf); raf = setTimeout(() => { update(); if (active && Date.now() < settleUntil) kick(); }, 40); };
  const settle = (ms = 700) => { settleUntil = Date.now() + ms; kick(); };

  // ---------- app state the steps need (opened through the app's own controls) ----------
  const hashNow = () => location.hash.replace(/^#/, "");
  function setHashQuiet(h) {
    quiet = true;
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
    window.dispatchEvent(new Event("hashchange"));
    quiet = false;
  }
  async function ensureDemo() {
    if (q("#results .card")) return;
    const p = new URLSearchParams(hashNow()); p.delete("doc"); p.delete("rec"); p.delete("view");
    if (!p.get("q")) p.set("q", "znak towarowy");
    p.delete("m"); p.delete("group");
    for (const k of [...p.keys()]) if (!["q", "group"].includes(k)) p.delete(k);
    setHashQuiet(p.toString());
    await waitFor(() => q("#results .card"), 6000);
  }
  async function still(el) {  // wait until a sliding panel stops moving
    let prev = -1;
    for (let i = 0; i < 20; i++) { const y = Math.round(el.getBoundingClientRect().top * 2); if (y === prev) return; prev = y; await sleep(70); }
  }
  async function syncUi(needs) {
    const want = (n) => needs.includes(n);
    if (!$("drawer").hidden && !want("drawer")) { $("dClose").click(); await waitFor(() => $("drawer").hidden, 2000); }
    if ($("tools").classList.contains("open") && !(want("tools") && !toolsInline())) { $("toolsBtn").click(); await sleep(30); }
    if ($("sidebar").classList.contains("open") && !(want("sheet") && mqNarrow.matches)) { $("filtersBtn").click(); await sleep(300); }
    if (want("sheet") && mqNarrow.matches && !$("sidebar").classList.contains("open")) { $("filtersBtn").click(); await sleep(320); await still($("sidebar")); }
    if (want("tools") && !toolsInline() && !$("tools").classList.contains("open")) { $("toolsBtn").click(); await sleep(30); }
    if (want("drawer") && $("drawer").hidden) {
      const t = q("#results .card-title");
      if (t) {
        t.click();
        await waitFor(() => !$("drawer").hidden && $("dBadges").children.length && $("dBody").textContent !== "Ładuję…", 5000);
        await still($("drawer"));
      }
    }
  }

  // ---------- popover ----------
  function build() {
    root = document.createElement("div");
    root.className = "tour-root";
    root.innerHTML = `<div class="tour-block"></div><div class="tour-spot"></div>
      <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tourT" tabindex="-1" data-dock="bottom">
        <div class="tour-live" aria-live="polite" aria-atomic="true"><div class="tour-k" id="tourK"></div><h2 class="tour-t" id="tourT"></h2><p class="tour-x" id="tourX"></p></div>
        <div class="tour-nav"><button type="button" class="tour-b ghost" id="tourSkip">Pomiń</button><span class="tour-sp"></span>
          <button type="button" class="tour-b" id="tourPrev">Wstecz</button><button type="button" class="tour-b primary" id="tourNext">Dalej</button></div>
      </div>`;
    document.body.append(root);
    spot = root.querySelector(".tour-spot"); block = root.querySelector(".tour-block"); pop = root.querySelector(".tour-pop");
    root.addEventListener("click", (e) => {
      e.stopPropagation();  // the app closes menus on outside clicks; a click here must not
      const id = e.target.closest("button")?.id;
      if (id === "tourSkip") end(); else if (id === "tourPrev") go(idx - 1); else if (id === "tourNext") go(idx + 1);
    });
  }

  async function go(i) {
    if (!active) return;
    if (i >= STEPS.length) return end();
    idx = Math.max(0, i);
    const my = ++token, s = STEPS[idx], keepFocus = pop.contains(document.activeElement) ? document.activeElement : pop;
    $("tourK").textContent = `Krok ${idx + 1} z ${STEPS.length}`;
    $("tourT").textContent = s.t;
    $("tourX").textContent = typeof s.x === "function" ? s.x() : s.x;
    $("tourPrev").hidden = idx === 0;
    $("tourNext").textContent = idx === STEPS.length - 1 ? "Zakończ" : "Dalej";
    $("tourSkip").hidden = idx === STEPS.length - 1;
    pop.dataset.dock = s.dock || "bottom";
    if (idx > 0) await ensureDemo();
    if (my !== token) return;
    await syncUi(s.needs || []);
    if (my !== token) return;
    if (s.needs && s.needs.includes("tools") && !toolsInline()) await sleep(30);
    cur = s.target ? (await waitFor(() => { const l = s.target().filter(shown); return l.length ? l : null; }, 2500)) || [] : [];
    if (my !== token) return;
    if (!pop.contains(keepFocus) || keepFocus.hidden) pop.focus(); else keepFocus.focus();
    reveal(cur, s);
    update(); settle(800);
    setTimeout(() => { if (my === token && active) { cur = cur.filter((e) => document.contains(e)); reveal(cur, s); update(); } }, 900);  // again once sheet / drawer have stopped sliding
  }

  async function start() {
    if (active) return;
    dismissOffer();
    ls.set(KEY, "1");
    lastFocus = document.activeElement;
    saved = { hash: hashNow(), y: window.scrollY, side: [$("sidebar").scrollTop, $("facets").scrollTop] };
    pushes = 0; active = true;
    document.body.classList.add("tour-on");
    build();
    const p = new URLSearchParams(saved.hash);
    if (p.has("doc")) { p.delete("doc"); p.delete("rec"); p.delete("view"); setHashQuiet(p.toString()); await waitFor(() => $("drawer").hidden, 2000); }
    pop.focus();
    go(0);
  }

  async function end() {
    if (!active) return;
    active = false; token++;
    clearTimeout(raf);
    root.remove();
    document.body.classList.remove("tour-on");
    await syncUi([]);
    quiet = true;
    if (pushes > 0) {  // the steps opened panels through the app: step back through those history entries
      await new Promise((res) => { const f = () => { window.removeEventListener("hashchange", f); res(); }; window.addEventListener("hashchange", f); history.go(-pushes); setTimeout(res, 600); });
    }
    quiet = false;
    if (hashNow() !== saved.hash) setHashQuiet(saved.hash);
    $("sidebar").scrollTop = saved.side[0]; $("facets").scrollTop = saved.side[1];
    window.scrollTo(0, saved.y);
    if (lastFocus && lastFocus !== document.body && document.contains(lastFocus) && shown(lastFocus)) try { lastFocus.focus(); } catch {} else $("tourBtn").focus();
  }

  window.addEventListener("hashchange", () => { if (active && !quiet) pushes++; });
  window.addEventListener("resize", () => { if (active) { update(); settle(300); } });
  window.addEventListener("scroll", () => { if (active) kick(); }, true);
  let teT;
  document.addEventListener("transitionend", (e) => {  // sheet / drawer finished sliding: measure again
    if (!active || e.target === spot || root.contains(e.target)) return;
    clearTimeout(teT);
    teT = setTimeout(() => { if (active) { reveal(cur.filter((x) => document.contains(x)), STEPS[idx]); update(); settle(150); } }, 80);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopImmediatePropagation();  // the app's own shortcuts (/, ?, g, Esc, Tab trap) are off during the tour
    if (e.key === "Escape") { e.preventDefault(); end(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    else if (e.key === "Tab") {
      const f = [...pop.querySelectorAll("button")].filter((b) => !b.hidden);
      const i = f.indexOf(document.activeElement), n = f.length;
      e.preventDefault();
      f[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n].focus();
    }
  }, true);
  document.addEventListener("focusin", (e) => { if (active && root && !root.contains(e.target)) pop.focus(); });

  // ---------- first-visit offer ----------
  let offer = null, offerT;
  function dismissOffer() { clearTimeout(offerT); if (offer) { offer.remove(); offer = null; } }
  function showOffer() {
    offer = document.createElement("section");
    offer.className = "tour-offer"; offer.setAttribute("role", "region"); offer.setAttribute("aria-label", "Przewodnik po wyszukiwarce");
    offer.innerHTML = `<p>Pierwszy raz? Zobacz 30-sekundowy przewodnik.</p><div class="tour-offer-b"><button type="button" class="tour-b primary" data-a="go">Rozpocznij</button><button type="button" class="tour-b" data-a="no">Nie teraz</button></div>`;
    offer.addEventListener("click", (e) => { const a = e.target.closest("button")?.dataset.a; if (a === "go") start(); else if (a === "no") dismissOffer(); });
    offer.addEventListener("keydown", (e) => { if (e.key === "Escape") dismissOffer(); });
    document.body.append(offer);
    offerT = setTimeout(dismissOffer, 25000);
  }

  $("tourBtn").addEventListener("click", start);
  if (!ls.get(KEY) && !new URLSearchParams(hashNow()).get("doc")) {
    ls.set(KEY, "1");  // offered once, whatever the visitor does with it
    setTimeout(() => { if (!active) showOffer(); }, 1200);
  }
})();
