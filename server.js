import express from "express";
import PDFDocument from "pdfkit";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Health check endpoint (no auth) for uptime monitors.
app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_MAP_MODEL = process.env.OPENAI_MAP_MODEL || "gpt-4o-mini";
const APP_PASSWORD = process.env.APP_PASSWORD || "atilla2026";

// ---------- helpers ----------

// Basic auth middleware — browser prompts for password.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Review Intel"');
    return res.status(401).send("Authentication required");
  }
  const credentials = Buffer.from(auth.slice(6), "base64").toString("utf-8");
  const [user, pass] = credentials.split(":");
  if (pass !== APP_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Review Intel"');
    return res.status(401).send("Authentication required");
  }
  next();
}

// Apply auth to all API routes.
app.use("/api", requireAuth);

// Accepts a full App Store URL, "id123456789", or a raw numeric ID.
function parseAppId(input) {
  const trimmed = String(input).trim();
  const urlMatch = trimmed.match(/id(\d{6,})/);
  if (urlMatch) return urlMatch[1];
  const numMatch = trimmed.match(/^(\d{6,})$/);
  if (numMatch) return numMatch[1];
  return null;
}

// ---------- routes ----------

app.get("/api/health", (_req, res) => {
  res.json({
    apify: Boolean(APIFY_TOKEN),
    openai: Boolean(OPENAI_API_KEY),
  });
});

// Resolve app metadata (name, icon, rating) via the public iTunes Lookup API.
app.get("/api/app-info", async (req, res) => {
  try {
    const appId = parseAppId(req.query.app || "");
    const country = (req.query.country || "us").toLowerCase();
    if (!appId) return res.status(400).json({ error: "Could not extract an App Store ID from your input. Paste the full App Store URL or the numeric ID." });

    const r = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`);
    const data = await r.json();
    if (!data.results || data.results.length === 0) {
      return res.status(404).json({ error: `No app found for ID ${appId} in the "${country}" store. Try another country.` });
    }
    const a = data.results[0];
    res.json({
      appId,
      name: a.trackName,
      developer: a.artistName,
      icon: a.artworkUrl100,
      rating: a.averageUserRating,
      ratingCount: a.userRatingCount,
      genre: a.primaryGenreName,
      description: (a.description || "").slice(0, 1500),
      url: a.trackViewUrl,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to look up app info: " + err.message });
  }
});

// ---------- scraping ----------

const MAX_REVIEWS_CAP = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize whatever field names the actor returns.
function normalizeReviews(items, country) {
  return (Array.isArray(items) ? items : []).map((it) => ({
    title: it.title || it.reviewTitle || "",
    text: it.text || it.review || it.body || it.content || "",
    rating: it.rating ?? it.score ?? it.stars ?? null,
    version: it.version || it.appVersion || "",
    date: it.date || it.updated || it.createdAt || "",
    userName: it.userName || it.author || "",
    country: it.country || country,
  })).filter((rv) => rv.text || rv.title);
}

// Start the Apify actor asynchronously and poll until done, reporting item counts.
async function scrapeReviews(appId, country, maxReviews, onProgress = () => {}) {
  const input = {
    appIds: [appId],
    country: country.toLowerCase(),
    maxItems: Math.min(Number(maxReviews) || 300, MAX_REVIEWS_CAP),
  };

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/thewolves~appstore-reviews-scraper/runs?token=${APIFY_TOKEN}&timeout=900`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
  );
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Apify run failed to start (${startRes.status}): ${text.slice(0, 500)}`);
  }
  const run = (await startRes.json()).data;
  const runId = run.id;
  const datasetId = run.defaultDatasetId;
  const startedAt = Date.now();

  while (true) {
    await sleep(2500);
    const stRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const status = (await stRes.json()).data?.status;

    let itemCount = 0;
    try {
      const dsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}?token=${APIFY_TOKEN}`);
      itemCount = (await dsRes.json()).data?.itemCount ?? 0;
    } catch { /* count is best-effort */ }
    onProgress(itemCount, status);

    if (status === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      throw new Error(`Apify run ended with status ${status}. Check https://console.apify.com/actors/runs/${runId}`);
    }
    if (Date.now() - startedAt > 15 * 60 * 1000) {
      throw new Error("Scrape timed out after 15 minutes.");
    }
  }

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true&format=json&limit=${input.maxItems}`
  );
  if (!itemsRes.ok) throw new Error(`Failed to fetch dataset items (${itemsRes.status}).`);
  const items = await itemsRes.json();
  return normalizeReviews(items, country);
}

// ---------- GPT analysis ----------

const ANALYSIS_JSON_SCHEMA = {
  name: "app_review_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["meta", "summary", "categories", "productSignals", "battlePlan"],
    properties: {
      meta: {
        type: "object",
        additionalProperties: false,
        required: ["reviewCount", "dateRange"],
        properties: {
          reviewCount: { type: "integer" },
          dateRange: { type: "string" },
        },
      },
      summary: { type: "string" },
      categories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "severity", "frequency", "insight", "quotes"],
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["complaint", "request", "praise"] },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            frequency: { type: "string" },
            insight: { type: "string" },
            quotes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "rating", "translated"],
                properties: {
                  text: { type: "string" },
                  rating: { type: ["integer", "null"] },
                  translated: { type: "boolean" },
                },
              },
            },
          },
        },
      },
      productSignals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "type", "featureArea", "description", "quotes", "mentionCount", "novelty", "competitorMentioned", "competitorFeatureQuality", "marketingAngle"],
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["missing_feature", "competitor_weakness", "competitor_strength", "workflow_friction", "unmet_use_case", "pricing_signal"] },
            featureArea: { type: "string" },
            description: { type: "string" },
            quotes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "rating", "translated"],
                properties: {
                  text: { type: "string" },
                  rating: { type: ["integer", "null"] },
                  translated: { type: "boolean" },
                },
              },
            },
            mentionCount: { type: "integer" },
            novelty: { type: "boolean" },
            competitorMentioned: { type: ["string", "null"] },
            competitorFeatureQuality: { type: ["string", "null"], enum: ["does_it_but_poorly", "does_not_have_it", null] },
            marketingAngle: { type: "string" },
          },
        },
      },
      battlePlan: {
        type: "object",
        additionalProperties: false,
        required: ["positioning", "features", "designIdeas", "quickWins", "avoid"],
        properties: {
          positioning: { type: "string" },
          features: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "why", "impact", "effort", "sourceSignalIds"],
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                impact: { type: "string", enum: ["high", "medium", "low"] },
                effort: { type: "string", enum: ["high", "medium", "low"] },
                sourceSignalIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          designIdeas: { type: "array", items: { type: "string" } },
          quickWins: { type: "array", items: { type: "string" } },
          avoid: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a product strategist for a mobile app company. You are given a raw list of product signals and operational theme digests extracted from batches of a competitor's App Store reviews, plus deterministic sentiment percentages computed from star ratings. Base every claim strictly on this material — never invent, paraphrase-as-quote, or embellish a review's content.

PRODUCT SIGNALS ("productSignals" — the most important output):
1. Merge near-duplicate signals (same underlying gap, different wording) into one entry, summing mentionCount and keeping the most specific quote(s), up to 3 per signal.
2. Cluster signals into featureArea groups — choose sensible group names based on what's actually present (e.g. "Pronunciation & Speaking", "Personalization", "Pricing & Access"). Do not force a fixed taxonomy.
3. Assign each final signal a sequential id: "sig_001", "sig_002", …
4. There is NO cap on total signal count. Keep everything genuinely specific — scale with review volume, not a fixed target range. A 3000-review set should typically yield dozens of signals.
5. mentionCount: 1 is not a reason to discard — set "novelty": true and keep it.
6. competitor_weakness (they have it, it's bad — "do it better") and competitor_strength (they have it, it's genuinely good — "we must match it") are distinct types leading to different strategy. Preserve the distinction; set competitorFeatureQuality where applicable.
7. Discard only vague sentiment with no specific referent ("terrible app", "love it") — that belongs in categories.
8. marketingAngle: a genuinely usable one-sentence marketing/positioning line if we ship the fix — not a restatement of the description.

OPERATIONAL CATEGORIES ("categories"):
- Standard thematic categories (billing, bugs, support, stability, pricing), frequency-weighted.
- Merge near-duplicates; weight by recurrence. 4-8 categories, up to 6 quotes each — only quotes genuinely present, never fabricated or padded.
- "frequency" describes approximate recurrence (e.g. "~40 of 300 reviews", "recurring", "rare but severe").

BATTLE PLAN:
- battlePlan.features must be sourced primarily from productSignals, not operational categories. Every feature MUST list the specific signal ids it traces back to in "sourceSignalIds".
- Operational issues (billing, support, bugs) belong in "avoid" and "quickWins" — they are table stakes, not differentiators.
- Include 3-6 design ideas, 3-5 quick wins, 3-5 mistakes to avoid — each grounded in something observed in the reviews.

GENERAL:
- Use the provided sentiment percentages as-is in the summary — never recompute or estimate them.
- If the total review count is low (under ~30), state this explicitly in the summary and use cautious confidence language.
- In "meta", echo the review count and date range provided in the context.
- Non-English quotes: translate to English, set "translated": true.`;

const CHUNK_SIZE = 200; // reviews per map-pass call (sized to fit low-tier TPM limits)
const MAP_CONCURRENCY = 4; // parallel OpenAI calls during the map pass (mini has 200K TPM headroom)

// Run fn over items with limited concurrency, reporting completion counts.
async function mapPool(items, limit, fn, onEach = () => {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      done++;
      onEach(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Deterministic date range from review dates — never computed by the model.
function computeDateRange(reviews) {
  const dates = reviews.map((r) => new Date(r.date)).filter((d) => !isNaN(d)).sort((a, b) => a - b);
  if (dates.length === 0) return "unknown";
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const a = fmt(dates[0]);
  const b = fmt(dates[dates.length - 1]);
  return a === b ? a : `${a} - ${b}`;
}

// Deterministic sentiment from star ratings: 1-2★ negative, 3★ neutral, 4-5★ positive.
function computeSentiment(reviews) {
  let pos = 0, neu = 0, neg = 0, rated = 0;
  for (const r of reviews) {
    const rt = Number(r.rating);
    if (!Number.isFinite(rt) || rt < 1) continue;
    rated++;
    if (rt >= 4) pos++;
    else if (rt >= 3) neu++;
    else neg++;
  }
  if (rated === 0) return { positive: 0, neutral: 0, negative: 0 };
  const positive = Math.round((pos / rated) * 100);
  const negative = Math.round((neg / rated) * 100);
  return { positive, negative, neutral: 100 - positive - negative };
}

function formatReviews(reviews, startIndex = 0) {
  return reviews.map((r, i) =>
    `#${startIndex + i + 1} [${r.rating ?? "?"}★${r.version ? " v" + r.version : ""}${r.date ? " " + String(r.date).slice(0, 10) : ""}] ${r.title ? r.title + " — " : ""}${String(r.text).slice(0, 600)}`
  ).join("\n");
}

async function callOpenAI(messages, responseFormat, model = OPENAI_MODEL) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: responseFormat,
        messages,
      }),
    });

    if (r.status === 429 && attempt < MAX_RETRIES) {
      // Rate limited — honor the suggested wait if present, otherwise back off exponentially.
      const text = await r.text();
      const m = text.match(/try again in ([\d.]+)s/i);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 1000 : Math.min(60000, 4000 * 2 ** attempt);
      console.log(`OpenAI 429 (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      continue;
    }

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`OpenAI API failed (${r.status}): ${text.slice(0, 500)}`);
    }
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return { parsed: JSON.parse(content), usage: data.usage };
  }
}

// Pass A: per-chunk extraction — raw product signals plus a lightweight operational digest.
async function extractChunkDigest(chunkReviews, startIndex, appName) {
  const mapPrompt = `You are extracting product signals from a batch of App Store reviews of "${appName}" for competitive analysis. Do NOT summarize overall sentiment, categorize, or build plans — that happens in a later step.

Your primary job: find EVERY specific, concrete mention of a missing feature, a workflow problem, an unmet use case, a competitor comparison, or a pricing/access complaint.

Rules for "signals":
- Frequency does not matter. A single review naming one specific gap is more valuable than fifty vague "bad app" reviews — extract the single mention.
- Discard vague sentiment with no specific referent.
- If a competitor app is named, always capture it, and classify: the competitor "has it and does it well" → type "competitor_strength"; "has it but does it poorly" → type "competitor_weakness" with competitorFeatureQuality "does_it_but_poorly"; if the comparison has no specifics, skip it — too vague. If ${appName} lacks something a competitor has, competitorFeatureQuality is "does_not_have_it".
- Never fabricate or paraphrase a quote. Use the reviewer's actual words, lightly trimmed only for length.
- If a review is not in English, translate the quote and set "translated": true.
- No cap on signal count — extract everything genuinely present.

Secondary job: "themes" — recurring OPERATIONAL issues only (billing, bugs, crashes, support, account problems). Max 4 verbatim quotes per theme, merge near-duplicates.

Respond with valid JSON only:
{
  "signals": [ { "type": "missing_feature" | "competitor_weakness" | "competitor_strength" | "workflow_friction" | "unmet_use_case" | "pricing_signal", "description": "specific, concrete description of what the user wanted or ran into", "quote": "verbatim", "rating": <int|null>, "translated": <bool>, "competitorMentioned": "app name or null", "competitorFeatureQuality": "does_it_but_poorly" | "does_not_have_it" | null } ],
  "themes": [ { "name": "theme name", "type": "complaint" | "request" | "praise", "count": <int>, "quotes": [ { "text": "verbatim", "rating": <int|null>, "translated": <bool> } ] } ]
}`;

  const { parsed } = await callOpenAI(
    [
      { role: "system", content: mapPrompt },
      { role: "user", content: formatReviews(chunkReviews, startIndex) },
    ],
    { type: "json_object" },
    OPENAI_MAP_MODEL // cheaper model with much higher TPM limits for the bulk pass
  );
  return parsed;
}

// Keep the synthesis prompt under TPM limits by trimming digest quotes if needed.
const SYNTHESIS_CHAR_BUDGET = 90000; // ~22K tokens
function serializeDigests(digests, quotesPerTheme) {
  const trimmed = digests.map((d) => ({
    ...d,
    themes: (d.themes || []).map((t) => ({ ...t, quotes: (t.quotes || []).slice(0, quotesPerTheme) })),
  }));
  return trimmed.map((d, i) => `--- Batch ${i + 1} ---\n${JSON.stringify(d)}`).join("\n\n");
}
function digestsBlock(digests) {
  for (const quotesPerTheme of [4, 2, 1]) {
    const block = serializeDigests(digests, quotesPerTheme);
    if (block.length <= SYNTHESIS_CHAR_BUDGET) return block;
  }
  // Last resort: drop theme quotes entirely, keep product signals intact.
  return serializeDigests(digests, 0).slice(0, SYNTHESIS_CHAR_BUDGET);
}

// Analyze reviews with GPT. Small sets go in one call; large sets use map-reduce.
async function analyzeReviews(reviews, appInfo, onProgress = () => {}) {
  const sentiment = computeSentiment(reviews);

  const appContext = `Competitor app: ${appInfo.name || "Unknown"} by ${appInfo.developer || "Unknown"} (${appInfo.genre || ""}, avg rating ${appInfo.rating ?? "?"} from ${appInfo.ratingCount ?? "?"} ratings).
App description (for context): ${appInfo.description || "N/A"}
Pre-computed sentiment from star ratings of the ${reviews.length} scraped reviews: ${sentiment.positive}% positive, ${sentiment.neutral}% neutral, ${sentiment.negative}% negative.`;

  // Pass A — chunked extraction, always (uniform pipeline regardless of volume).
  const chunks = [];
  for (let i = 0; i < reviews.length; i += CHUNK_SIZE) {
    chunks.push({ reviews: reviews.slice(i, i + CHUNK_SIZE), startIndex: i });
  }
  onProgress({ phase: "map", done: 0, total: chunks.length });
  const digests = await mapPool(
    chunks,
    MAP_CONCURRENCY,
    (c) => extractChunkDigest(c.reviews, c.startIndex, appInfo.name || "Unknown"),
    (done, total) => onProgress({ phase: "map", done, total })
  );

  const dateRange = computeDateRange(reviews);

  // Pass B — synthesis over all raw signals + operational digests.
  const userPrompt = `${appContext}
Review date range: ${dateRange}.

${reviews.length} user reviews were processed in ${digests.length} extraction batches. Below are the raw product signals and operational theme digests from each batch (quotes are verbatim from real reviews — only reuse these, never invent new ones).

Merge, dedupe, and cluster the signals per your instructions — keep every genuinely specific signal, even singletons. Aggregate theme counts across batches when judging category frequency.

${digestsBlock(digests)}

Synthesize the final analysis for all ${reviews.length} reviews and return the JSON.`;

  onProgress({ phase: "synthesize" });
  const { parsed: analysis, usage } = await callOpenAI(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { type: "json_schema", json_schema: ANALYSIS_JSON_SCHEMA }
  );

  // Server knows the truth for these — don't trust the model with math.
  analysis.meta = { reviewCount: reviews.length, dateRange };
  analysis.sentiment = sentiment;

  return { analysis, usage };
}

// Full pipeline with streamed NDJSON progress events.
app.post("/api/run", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    if (!APIFY_TOKEN) throw new Error("Apify token is missing. Add APIFY_TOKEN to .env and restart the server.");
    if (!OPENAI_API_KEY) throw new Error("OpenAI API key is missing in .env.");

    const { app: appInput, country = "us", maxReviews = 300, appInfo = {} } = req.body;
    const appId = parseAppId(appInput || "");
    if (!appId) throw new Error("Could not extract an App Store ID from your input.");
    const target = Math.min(Number(maxReviews) || 300, MAX_REVIEWS_CAP);

    send({ stage: "scrape_start", target });
    const reviews = await scrapeReviews(appId, country, target, (scraped, status) =>
      send({ stage: "scrape_progress", scraped, status, target })
    );
    send({ stage: "scrape_done", count: reviews.length });
    if (reviews.length === 0) throw new Error("No reviews found for this app in the selected country. Try another country.");

    const { analysis } = await analyzeReviews(reviews, appInfo, (p) => send({ stage: "analyze_progress", ...p }));
    send({ stage: "done", analysis, count: reviews.length });
  } catch (err) {
    send({ stage: "error", error: err.message });
  }
  res.end();
});

// ---------- PDF export ----------

const PDF_COLORS = {
  text: "#1d1d1f",
  secondary: "#6e6e73",
  accent: "#0071e3",
  red: "#ff3b30",
  orange: "#ff9500",
  green: "#34c759",
  purple: "#a855f7",
};
const PDF_TYPE_LABELS = {
  missing_feature: ["Missing Feature", PDF_COLORS.accent],
  competitor_weakness: ["Competitor Weakness", PDF_COLORS.purple],
  competitor_strength: ["Competitor Strength", PDF_COLORS.green],
  workflow_friction: ["Workflow Friction", PDF_COLORS.orange],
  unmet_use_case: ["Unmet Use Case", PDF_COLORS.red],
  pricing_signal: ["Pricing Signal", "#b8860b"],
};
const SEV_COLORS = { high: PDF_COLORS.red, medium: PDF_COLORS.orange, low: PDF_COLORS.secondary };

app.post("/api/export-pdf", (req, res) => {
  try {
    const { appInfo = {}, analysis = {}, reviewCount = 0 } = req.body;
    const doc = new PDFDocument({ margin: 54, size: "A4", bufferPages: true });

    const safeName = String(appInfo.name || "app").replace(/[^a-z0-9-_ ]/gi, "").trim() || "app";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="review-intel-${safeName}.pdf"`);
    doc.pipe(res);

    const W = doc.page.width - 108; // content width
    const heading = (t, size = 18, color = PDF_COLORS.text) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(1).fontSize(size).fillColor(color).font("Helvetica-Bold").text(t).moveDown(0.4);
    };
    const body = (t, opts = {}) =>
      doc.fontSize(opts.size || 10.5).fillColor(opts.color || PDF_COLORS.text).font(opts.font || "Helvetica").text(t, { width: W, ...opts });

    // --- Cover section ---
    doc.fontSize(26).font("Helvetica-Bold").fillColor(PDF_COLORS.text).text(appInfo.name || "Competitor Analysis");
    body(`${appInfo.developer || ""}${appInfo.genre ? " · " + appInfo.genre : ""}`, { color: PDF_COLORS.secondary, size: 12 });
    doc.moveDown(0.8);
    const s = analysis.sentiment || {};
    body(
      `${reviewCount.toLocaleString()} reviews analyzed · store rating ${appInfo.rating ?? "—"} (${(appInfo.ratingCount ?? 0).toLocaleString()} ratings) · period ${analysis.meta?.dateRange || "unknown"}`,
      { color: PDF_COLORS.secondary }
    );
    body(`Sentiment: ${s.positive ?? "—"}% positive · ${s.neutral ?? "—"}% neutral · ${s.negative ?? "—"}% negative`, { color: PDF_COLORS.secondary });
    heading("Executive Summary", 15);
    body(analysis.summary || "—");

    // --- Product Signals ---
    heading("Product Signals", 18);
    const signals = analysis.productSignals || [];
    if (signals.length === 0) body("No specific product signals surfaced.", { color: PDF_COLORS.secondary });
    const groups = new Map();
    signals.forEach((sig) => {
      const k = sig.featureArea || "Other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(sig);
    });
    for (const [area, items] of groups) {
      heading(`${area} (${items.length})`, 13);
      for (const sig of items) {
        if (doc.y > doc.page.height - 150) doc.addPage();
        const [label, color] = PDF_TYPE_LABELS[sig.type] || [sig.type, PDF_COLORS.secondary];
        const badges = [label];
        if (sig.mentionCount > 1) badges.push(`×${sig.mentionCount}`);
        if (sig.novelty) badges.push("singleton");
        if (sig.competitorMentioned) badges.push(`vs ${sig.competitorMentioned}`);
        doc.fontSize(9).font("Helvetica-Bold").fillColor(color).text(`${badges.join("  ·  ")}   ${sig.id || ""}`);
        body(sig.description, { font: "Helvetica-Bold", size: 11 });
        for (const q of (sig.quotes || []).slice(0, 3)) {
          body(`“${q.text}”${q.rating != null ? ` (${q.rating}★)` : ""}${q.translated ? " [translated]" : ""}`, { font: "Helvetica-Oblique", color: PDF_COLORS.secondary, indent: 12 });
        }
        if (sig.marketingAngle) body(`Marketing angle: ${sig.marketingAngle}`, { color: PDF_COLORS.accent });
        doc.moveDown(0.6);
      }
    }

    // --- Categories (condensed) ---
    heading("Feedback Categories (operational)", 18);
    for (const c of analysis.categories || []) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.fontSize(11).font("Helvetica-Bold").fillColor(SEV_COLORS[c.severity] || PDF_COLORS.text)
        .text(`${c.name}  `, { continued: true })
        .fontSize(9).fillColor(PDF_COLORS.secondary).font("Helvetica")
        .text(`${c.type} · ${c.severity}${c.frequency ? " · " + c.frequency : ""}`);
      body(c.insight, { color: PDF_COLORS.text });
      doc.moveDown(0.5);
    }

    // --- Battle Plan ---
    heading("Battle Plan", 18);
    const bp = analysis.battlePlan || {};
    heading("Positioning", 13);
    body(bp.positioning || "—");
    heading("Features to Build", 13);
    for (const f of bp.features || []) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      body(f.title, { font: "Helvetica-Bold", size: 11 });
      body(`impact: ${f.impact} · effort: ${f.effort}${(f.sourceSignalIds || []).length ? " · source: " + f.sourceSignalIds.join(", ") : ""}`, { size: 9, color: PDF_COLORS.secondary });
      body(f.why);
      doc.moveDown(0.5);
    }
    const list = (title, items) => {
      if (!items?.length) return;
      heading(title, 13);
      items.forEach((it) => body(`•  ${it}`));
    };
    list("Design Ideas", bp.designIdeas);
    list("Quick Wins", bp.quickWins);
    list("Mistakes to Avoid", bp.avoid);

    // Footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor(PDF_COLORS.secondary)
        .text(`Review Intel — ${appInfo.name || ""} — page ${i + 1} of ${range.count}`, 54, doc.page.height - 40, { width: W, align: "center", lineBreak: false });
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "PDF export failed: " + err.message });
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`App Review Intel running → http://localhost:${PORT}`);
});
