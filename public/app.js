const $ = (id) => document.getElementById(id);

let lastResult = null;

// ---------- health check ----------
(async () => {
  try {
    const h = await (await fetch("/api/health")).json();
    const badge = $("health-badge");
    if (!h.apify) {
      badge.textContent = "⚠️ Apify token missing — add APIFY_TOKEN to .env";
      badge.classList.add("warn");
    } else if (!h.openai) {
      badge.textContent = "⚠️ OpenAI key missing — add OPENAI_API_KEY to .env";
      badge.classList.add("warn");
    } else {
      badge.textContent = "● Connected";
    }
  } catch { /* server not ready */ }
})();

// ---------- helpers ----------
function showError(msg) {
  const box = $("error-box");
  box.textContent = msg;
  box.classList.remove("hidden");
}
function clearError() { $("error-box").classList.add("hidden"); }

function appChipHTML(info) {
  return `
    <img src="${info.icon}" alt="" />
    <div>
      <div class="app-name">${escapeHtml(info.name)}</div>
      <div class="app-dev">${escapeHtml(info.developer)} · ${escapeHtml(info.genre || "")} · ${info.rating ? info.rating.toFixed(1) + "★" : ""}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStep(id, state) {
  const el = $(id);
  el.classList.remove("active", "done");
  if (state) el.classList.add(state);
}

function setBar(id, pct) {
  $(id).style.width = Math.max(0, Math.min(100, pct)) + "%";
}

// ---------- main flow ----------
$("analyze-btn").addEventListener("click", runAnalysis);
$("app-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runAnalysis(); });
$("new-btn")?.addEventListener("click", () => {
  $("results").classList.add("hidden");
  $("hero").classList.remove("hidden");
  $("app-input").value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("export-btn")?.addEventListener("click", () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `review-intel-${lastResult.appInfo?.name || "app"}.json`;
  a.click();
});
$("export-pdf-btn")?.addEventListener("click", async () => {
  if (!lastResult) return;
  const btn = $("export-pdf-btn");
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const res = await fetch("/api/export-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastResult),
    });
    if (!res.ok) throw new Error(`PDF export failed (${res.status}).`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `review-intel-${lastResult.appInfo?.name || "app"}.pdf`;
    a.click();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Export PDF";
  }
});

async function runAnalysis() {
  clearError();
  const appInput = $("app-input").value.trim();
  const country = $("country-select").value;
  const maxReviews = $("max-select").value;
  if (!appInput) return showError("Paste an App Store URL or app ID first.");

  const btn = $("analyze-btn");
  btn.disabled = true;
  btn.textContent = "Working…";

  try {
    // 1. App info
    const infoRes = await fetch(`/api/app-info?app=${encodeURIComponent(appInput)}&country=${country}`);
    const info = await infoRes.json();
    if (!infoRes.ok) throw new Error(info.error);

    $("hero").classList.add("hidden");
    $("progress").classList.remove("hidden");
    $("app-chip").innerHTML = appChipHTML(info);
    setStep("step-scrape", "active");
    setStep("step-analyze", null);
    $("scrape-text").textContent = "Starting App Store scrape…";
    $("analyze-text").textContent = "GPT analysis";
    setBar("scrape-bar", 0);
    setBar("analyze-bar", 0);

    // 2. Full pipeline with streamed progress
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: appInput, country, maxReviews, appInfo: info }),
    });
    if (!res.ok || !res.body) throw new Error(`Server error (${res.status}).`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final = null;

    const handleEvent = (ev) => {
      switch (ev.stage) {
        case "scrape_start":
          $("scrape-text").textContent = `Scraping reviews… 0 / ${ev.target.toLocaleString()}`;
          break;
        case "scrape_progress":
          $("scrape-text").textContent = `Scraping reviews… ${ev.scraped.toLocaleString()} / ${ev.target.toLocaleString()}`;
          setBar("scrape-bar", (ev.scraped / ev.target) * 100);
          break;
        case "scrape_done":
          $("scrape-text").textContent = `Scraped ${ev.count.toLocaleString()} reviews`;
          setBar("scrape-bar", 100);
          setStep("step-scrape", "done");
          setStep("step-analyze", "active");
          break;
        case "analyze_progress":
          if (ev.phase === "map") {
            $("analyze-text").textContent = ev.total > 1
              ? `Analyzing reviews… batch ${ev.done} / ${ev.total}`
              : "Analyzing reviews…";
            setBar("analyze-bar", ev.total > 1 ? (ev.done / ev.total) * 90 : 45);
          } else if (ev.phase === "synthesize") {
            $("analyze-text").textContent = "Synthesizing battle plan…";
            setBar("analyze-bar", 92);
          }
          break;
        case "done":
          final = ev;
          break;
        case "error":
          throw new Error(ev.error);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) handleEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) handleEvent(JSON.parse(buf));

    if (!final) throw new Error("Connection ended before analysis finished. Try again.");

    setBar("analyze-bar", 100);
    setStep("step-analyze", "done");
    lastResult = { appInfo: info, reviewCount: final.count, analysis: final.analysis };
    setTimeout(() => renderResults(info, final.count, final.analysis), 400);
  } catch (err) {
    $("progress").classList.add("hidden");
    $("hero").classList.remove("hidden");
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}

// ---------- rendering ----------
function renderResults(info, reviewCount, a) {
  $("progress").classList.add("hidden");
  $("results").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  $("result-app-chip").innerHTML = appChipHTML(info);
  const dateRange = a.meta?.dateRange && a.meta.dateRange !== "unknown" ? a.meta.dateRange : null;
  $("stats-row").innerHTML = `
    <div><strong>${reviewCount}</strong>reviews analyzed</div>
    <div><strong>${info.rating ? info.rating.toFixed(1) : "—"}★</strong>store rating</div>
    <div><strong>${(info.ratingCount ?? 0).toLocaleString()}</strong>total ratings</div>
    ${dateRange ? `<div><strong>${escapeHtml(dateRange)}</strong>review period</div>` : ""}`;

  // Summary + sentiment
  $("summary-text").textContent = a.summary || "";
  const s = a.sentiment || { positive: 0, neutral: 0, negative: 0 };
  $("sentiment-bar").innerHTML = `
    <div class="pos" style="width:${s.positive}%"></div>
    <div class="neu" style="width:${s.neutral}%"></div>
    <div class="neg" style="width:${s.negative}%"></div>`;
  $("sentiment-legend").innerHTML = `
    <span><span class="dot" style="background:var(--green)"></span>Positive ${s.positive}%</span>
    <span><span class="dot" style="background:var(--gray)"></span>Neutral ${s.neutral}%</span>
    <span><span class="dot" style="background:var(--red)"></span>Negative ${s.negative}%</span>`;

  // Categories — severity shown as a colored left border, single type pill only.
  $("categories").innerHTML = (a.categories || []).map((c, idx) => {
    const quotes = (c.quotes || []).map((q) => `
      <div class="quote">“${escapeHtml(q.text)}”${q.rating != null ? `<span class="stars">${q.rating}★</span>` : ""}${q.translated ? `<span class="translated-tag">translated</span>` : ""}</div>`).join("");
    return `
      <div class="card category-card sev-${escapeHtml(c.severity)}">
        <div class="category-head">
          <h3>${escapeHtml(c.name)}</h3>
          <span class="pill ${escapeHtml(c.type)}">${escapeHtml(c.type)}</span>
        </div>
        ${c.frequency ? `<div class="frequency">${escapeHtml(c.frequency)}</div>` : ""}
        <p>${escapeHtml(c.insight)}</p>
        <div class="quotes hidden" id="quotes-${idx}">${quotes}</div>
        <button class="quotes-toggle" data-target="quotes-${idx}">Show ${c.quotes?.length || 0} key quotes ↓</button>
      </div>`;
  }).join("");

  document.querySelectorAll(".quotes-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = $(btn.dataset.target);
      const isHidden = target.classList.toggle("hidden");
      btn.textContent = isHidden ? btn.textContent.replace("Hide", "Show").replace("↑", "↓") : btn.textContent.replace("Show", "Hide").replace("↓", "↑");
    });
  });

  // Product signals — grouped by featureArea, filterable.
  setupSignalFilters(a.productSignals || []);

  // Battle plan
  const bp = a.battlePlan || {};
  $("positioning-text").textContent = bp.positioning || "";
  $("features").innerHTML = (bp.features || []).map((f) => `
    <div class="card feature-card">
      <h3>${escapeHtml(f.title)}</h3>
      <div class="feature-meta">
        <span class="pill ${escapeHtml(f.impact)}">impact: ${escapeHtml(f.impact)}</span>
        <span class="pill ${escapeHtml(f.effort)}">effort: ${escapeHtml(f.effort)}</span>
      </div>
      <p>${escapeHtml(f.why)}</p>
      ${(f.sourceSignalIds || []).length ? `<div class="trace-links">source: ${f.sourceSignalIds.map((id) => `<a href="#${escapeHtml(id)}" class="trace-link">${escapeHtml(id)}</a>`).join(" ")}</div>` : ""}
    </div>`).join("");
  $("design-ideas").innerHTML = (bp.designIdeas || []).map((d) => `<li>${escapeHtml(d)}</li>`).join("");
  $("quick-wins").innerHTML = (bp.quickWins || []).map((d) => `<li>${escapeHtml(d)}</li>`).join("");
  $("avoid-list").innerHTML = (bp.avoid || []).map((d) => `<li>${escapeHtml(d)}</li>`).join("");
}

// ---------- product signals: filters + grouped rendering ----------
const SIGNAL_LABELS = {
  missing_feature: "Missing Feature",
  competitor_weakness: "Competitor Weakness",
  competitor_strength: "Competitor Strength",
  workflow_friction: "Workflow Friction",
  unmet_use_case: "Unmet Use Case",
  pricing_signal: "Pricing Signal",
};

function setupSignalFilters(signals) {
  const fill = (id, values) => {
    const sel = $(id);
    sel.length = 1; // keep the "All …" option
    values.forEach((v) => sel.add(new Option(id === "filter-type" ? (SIGNAL_LABELS[v] || v) : v, v)));
    sel.value = "";
  };
  fill("filter-area", [...new Set(signals.map((s) => s.featureArea).filter(Boolean))].sort());
  fill("filter-type", [...new Set(signals.map((s) => s.type).filter(Boolean))]);
  fill("filter-competitor", [...new Set(signals.map((s) => s.competitorMentioned).filter(Boolean))].sort());
  $("filter-novelty").checked = false;

  const apply = () => renderSignals(signals.filter((s) =>
    (!$("filter-area").value || s.featureArea === $("filter-area").value) &&
    (!$("filter-type").value || s.type === $("filter-type").value) &&
    (!$("filter-competitor").value || s.competitorMentioned === $("filter-competitor").value) &&
    (!$("filter-novelty").checked || s.novelty)
  ));
  ["filter-area", "filter-type", "filter-competitor"].forEach((id) => ($(id).onchange = apply));
  $("filter-novelty").onchange = apply;
  apply();
}

function renderSignals(signals) {
  if (signals.length === 0) {
    $("product-signals").innerHTML = `<div class="card"><p>No signals match — or none surfaced in these reviews. Sparse is honest signal; try more reviews or another competitor.</p></div>`;
    return;
  }
  const groups = new Map();
  signals.forEach((s) => {
    const key = s.featureArea || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });

  $("product-signals").innerHTML = [...groups.entries()].map(([area, items]) => `
    <details class="signal-group" open>
      <summary>${escapeHtml(area)} <span class="group-count">${items.length}</span></summary>
      ${items.map(signalCardHTML).join("")}
    </details>`).join("");
}

function signalCardHTML(s) {
  const quotes = (s.quotes || []).map((q) => `
    <div class="quote">“${escapeHtml(q.text)}”${q.rating != null ? `<span class="stars">${q.rating}★</span>` : ""}${q.translated ? `<span class="translated-tag">translated</span>` : ""}</div>`).join("");
  const quality = s.competitorFeatureQuality === "does_it_but_poorly" ? " · does it poorly"
    : s.competitorFeatureQuality === "does_not_have_it" ? " · they lack it" : "";
  return `
    <div class="card signal-card" id="${escapeHtml(s.id || "")}">
      <div class="signal-head">
        <span class="pill ${escapeHtml(s.type)}">${SIGNAL_LABELS[s.type] || escapeHtml(s.type)}</span>
        ${s.mentionCount > 1 ? `<span class="mention-count">×${s.mentionCount}</span>` : ""}
        ${s.novelty ? `<span class="pill novelty">singleton</span>` : ""}
        ${s.competitorMentioned ? `<span class="pill competitor">vs ${escapeHtml(s.competitorMentioned)}${quality}</span>` : ""}
        ${s.id ? `<span class="signal-id">${escapeHtml(s.id)}</span>` : ""}
      </div>
      <p class="signal-desc">${escapeHtml(s.description)}</p>
      ${quotes}
      ${s.marketingAngle ? `<div class="marketing-angle">📣 ${escapeHtml(s.marketingAngle)}</div>` : ""}
    </div>`;
}
