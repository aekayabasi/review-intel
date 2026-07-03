# Review Intel — Competitor App Review Analyzer

Paste an App Store link → Apify scrapes the reviews → GPT categorizes feedback and generates a battle plan to beat the competitor.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Get your Apify API token**
   - Sign up / log in at https://console.apify.com
   - Go to **Settings → API & Integrations** (https://console.apify.com/settings/integrations)
   - Copy your **Personal API token**
   - Paste it into `.env` as `APIFY_TOKEN=apify_api_...`

   The Apify CLI is **not** needed — the app calls the Apify REST API directly.
   The actor used (`thewolves/appstore-reviews-scraper`) is pay-per-result: **$0.10 per 1,000 reviews**, billed to your Apify account.

3. **Run**
   ```bash
   npm start
   ```
   Open http://localhost:3000

## Usage

- Paste a full App Store URL (e.g. `https://apps.apple.com/us/app/angry-birds-2/id880047117`), `id880047117`, or just `880047117`.
- Pick the store country and how many reviews to scrape.
- Get: sentiment breakdown, categorized feedback with the most valuable verbatim quotes, and a battle plan (features, design ideas, quick wins, mistakes to avoid).
- Export everything as JSON.

## Config (`.env`)

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI secret key |
| `APIFY_TOKEN` | Your Apify personal API token |
| `OPENAI_MODEL` | Default `gpt-4o` |
| `PORT` | Default `3000` |
