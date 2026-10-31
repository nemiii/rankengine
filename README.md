# rankengine

Zero-dependency (Node 22+) SEO + AI-search visibility engine. Feature set reconstructed from the RankAI
dashboard with REA browser captures; behavior behind RankAI's servers is inferred, not observed.

```
export ANTHROPIC_API_KEY=...                 # required (profile, writing, fixes, Claude tracking)
export OPENAI_API_KEY=... OPENAI_MODEL=...   # optional extra tracking platform
export GEMINI_API_KEY=... GEMINI_MODEL=...   # optional extra tracking platform
```

| RankAI section | rankengine |
|---|---|
| Onboarding: Business, Audience & Competitors | `init <url>` scans the site → profile; `show`, `set <field> <value>`, `set competitors add\|remove <x>` |
| Blog Post Settings (knowledge base, writer notes) | files in `data/knowledge/` (≤25, md/txt/csv/json); `set writerNotes ...` |
| Publishing mode (auto/manual) | `set publishMode auto`; `publish` (one eligible article per run, skips Sunday); `publish <slug>`; `unpublish <slug>` |
| Website Audit (10 factors, grade) | `audit [maxPages]` |
| Crawlability check | `crawl` (robots.txt full-site/AI-crawler blocks, sitemap validity, llms.txt) |
| Technical SEO code changes | `fixes build\|list\|enable\|disable`; embed `<script src="…/fixes.js" defer>` |
| Keywords & Content (weeks, statuses) | `keywords [n]`, `add <keyword>`, `write [n]`, `articles [status]` |
| Custom-site integration API + sitemap | `serve` → `/api/v1/articles?page=&limit=`, `/api/v1/articles/:slug?format=html\|markdown`, `/sitemap.xml`, `/` status page |
| Analytics (GSC) | `import-gsc <csv>` (columns page,query,clicks,impressions,position), `analytics` |
| Rewrite until it ranks | `rewrite [minImpressions]` — rewrites published pages past position 10 using their real queries |
| AI Search Visibility (topics → prompts → tracking) | `topics`, `prompts [n]`, `track`, `visibility` (visibility %, rank, share of voice, cited sources) |
| AI Visibility Actions | `actions` |

Not included: Google Search Console OAuth (use CSV export), CMS-specific publishers (use the API or
`PUBLISH_WEBHOOK_URL`), keyword search-volume data (`searchVolume` stays null), image generation,
PDF knowledge-base files, team members/billing. Schedule `publish` / `track` with cron.
