#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { audit, crawlability } from "./audit.js";
import { buildFixes, CATEGORIES } from "./fixes.js";
import { findTopics, buildPrompts, track, summarize } from "./visibility.js";
import { load, save, llm, llmJson, slug, knowledge, frontMatter } from "./lib.js";

const [cmd, ...args] = process.argv.slice(2);
function die(msg) { console.error(msg); process.exit(1); }
const project = async () => (await load("project.json", null)) ?? die("run `init <url>` first");
const ARRAY_FIELDS = ["audiences", "competitors"];

const writer = (p) => `You are a senior content writer for ${p.name}. Write like the brand's own team in ${p.language}, never generic AI copy.
Voice: ${p.voice}. Audiences: ${p.audiences.join(", ")}. Product tiers: ${p.productTiers}.
${p.writerNotes ? `Writer notes from the customer (follow strictly): ${p.writerNotes}` : ""}`;

async function generateArticle(p, a, extra = "") {
  const kb = await knowledge();
  return llm(`Write a ${a.pageType} page titled "${a.title}" targeting the search "${a.keyword}" (${a.intent} intent) for buyers in ${p.country}.
Business: ${p.description}
${kb ? `Knowledge base (only state facts supported here or in the business description):\n${kb}` : ""}
${extra}
Output Markdown with YAML front matter (title, description <=155 chars, keyword).
Start with a single # H1. Answer the query directly in the first paragraph, use H2 sections, include a comparison table where useful, an FAQ section, and a call to action for ${p.url}.`,
    { system: writer(p), maxTokens: 8000 });
}

const commands = {
  // ── Onboarding (Business, Audience & Competitors, Blog settings, Publishing mode) ──
  async init(url) {
    if (!url) die("usage: init <url>");
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    const report = await audit(url, { maxPages: 8 });
    await save("audit.json", report);
    const sample = report.pages.slice(0, 6).map((pg) => `# ${pg.url}\n${pg.text}`).join("\n\n");
    const profile = await llmJson(`Scan this website and fill in the business profile.
Return {"name","country","language","description" (3-4 sentences),"productTiers" (pricing and inclusions if stated),"voice",
"audiences":[5-8 audience groups],"competitors":[{"name","url"}] (5-8 real, larger competitors),"differentiators":[]}.

${sample}`);
    await save("project.json", { url, ...profile, blogPath: "/blog", publishMode: "manual", stripTitleAndHero: false, writerNotes: "", ogImage: null });
    console.log(JSON.stringify(profile, null, 2));
    console.log("\nReview with `show`, edit with `set <field> <value>`. Put knowledge-base files (md/txt/csv/json, up to 25) in data/knowledge/.");
  },

  async show() { console.log(JSON.stringify(await project(), null, 2)); },

  async set(key, ...value) {
    const p = await project();
    if (!key) die(`usage: set <field> <value>   fields: ${Object.keys(p).join(", ")}`);
    let v = value.join(" ");
    if (ARRAY_FIELDS.includes(key)) {
      const [op, ...rest] = value, item = rest.join(" ");
      if (op === "add") p[key].push(key === "competitors" ? { name: item, url: item.includes(".") ? item : null } : item);
      else if (op === "remove") p[key] = p[key].filter((x) => (x.name ?? x) !== item && x.url !== item);
      else die(`usage: set ${key} add|remove <value>`);
    } else {
      if (v === "true" || v === "false") v = v === "true";
      p[key] = v;
    }
    await save("project.json", p);
    console.log(`${key} = ${JSON.stringify(p[key])}`);
  },

  // ── Website Audit + Technical SEO ──
  async audit(maxPages = "25") {
    const p = await project();
    const report = await audit(p.url, { maxPages: Number(maxPages) });
    await save("audit.json", report);
    console.log(`Grade ${report.grade} — crawled ${report.coverage.crawled}/${report.coverage.discovered} discovered pages\n`);
    for (const f of Object.values(report.factors)) console.log(`${f.issues ? String(f.issues).padStart(4) : "Pass"}  ${f.label}`);
    console.log(`\nCrawlability: ${report.crawlability.issues.length ? report.crawlability.issues.join("; ") : "no issues"}`);
    console.log("Run `fixes` to generate code changes.");
  },

  async crawl() {
    const p = await project();
    const r = await crawlability(new URL(p.url).origin);
    await save("crawlability.json", r);
    console.log(JSON.stringify(r, null, 2));
  },

  async fixes(sub = "build", id) {
    const p = await project();
    let fixes = await load("fixes.json", []);
    if (sub === "build") {
      const report = (await load("audit.json", null)) ?? die("run `audit` first");
      fixes = await buildFixes(report, p);
      await save("fixes.json", fixes);
    } else if (sub === "enable" || sub === "disable") {
      const hit = fixes.filter((f) => f.id === id || f.category === id);
      if (!hit.length) die(`no fix or category "${id}"`);
      for (const f of hit) f.enabled = sub === "enable";
      await save("fixes.json", fixes);
    } else if (sub !== "list") die("usage: fixes [build|list|enable <id|category>|disable <id|category>]");
    const active = fixes.filter((f) => f.enabled);
    console.log(`Active ${active.length} · Disabled ${fixes.length - active.length}`);
    for (const c of CATEGORIES) console.log(`  ${c.padEnd(22)} ${active.filter((f) => f.category === c).length}`);
    const byPage = Object.groupBy(active, (f) => f.page);
    for (const [page, fs] of Object.entries(byPage)) console.log(`\n${page} (${fs.length})\n${fs.map((f) => `  #${f.id} ${f.category}: ${f.op} ${f.value && typeof f.value === "string" ? `"${f.value}"` : f.href ?? ""}`).join("\n")}`);
    console.log(`\nApply on your site with: <script src="http://localhost:4310/fixes.js" defer></script> (run \`serve\`)`);
  },

  // ── Keywords & Content ──
  async keywords(count = "5") {
    const p = await project();
    const existing = await load("articles.json", []);
    const startWeek = Math.max(0, ...existing.map((a) => a.week)) + 1;
    const kws = await llmJson(`Business: ${JSON.stringify(p)}
Competitors to mine for keyword gaps: ${p.competitors.map((c) => c.url ?? c.name).join(", ")}.
Already targeted: ${existing.map((a) => a.keyword).join("; ") || "none"}.
Propose ${count} new high buyer-intent keywords for ${p.country} in ${p.language}, prioritizing ones competitors rank for and this site does not.
Return [{"keyword","intent":"commercial"|"transactional"|"informational","pageType":"comparison"|"alternatives"|"how-to"|"use-case"|"landing"|"listicle","title","estimatedDifficulty":"low"|"medium"|"high"}].`);
    const perWeek = 2;
    const added = kws.slice(0, Number(count)).map((k, i) => ({ ...k, slug: slug(k.title), week: startWeek + Math.floor(i / perWeek), status: "upcoming", searchVolume: null, createdAt: new Date().toISOString() }));
    await save("articles.json", [...existing, ...added]);
    for (const a of added) console.log(`W${a.week}  ${a.keyword}  →  ${a.title}`);
    console.log("\nsearchVolume is null: no keyword-volume data source is connected.");
  },

  async add(...keyword) {
    const articles = await load("articles.json", []);
    const k = keyword.join(" ") || die("usage: add <keyword>");
    articles.push({ keyword: k, title: k, slug: slug(k), intent: "commercial", pageType: "landing", week: Math.max(1, ...articles.map((a) => a.week)), status: "upcoming", searchVolume: null, createdAt: new Date().toISOString() });
    await save("articles.json", articles);
    console.log(`added "${k}"`);
  },

  async write(limit = "2") {
    const p = await project();
    const articles = await load("articles.json", []);
    const todo = articles.filter((a) => a.status === "upcoming").slice(0, Number(limit));
    if (!todo.length) die("no upcoming keywords; run `keywords` first");
    for (const a of todo) {
      a.markdown = await generateArticle(p, a);
      const { meta } = frontMatter(a.markdown);
      Object.assign(a, { title: meta.title ?? a.title, description: meta.description ?? "", status: "ready", writtenAt: new Date().toISOString() });
      await save("articles.json", articles);
      console.log(`ready: ${a.title}`);
    }
  },

  async articles(status) {
    const articles = await load("articles.json", []);
    const rows = articles.filter((a) => !status || a.status === status);
    for (const a of rows) console.log(`W${String(a.week).padEnd(3)} ${a.status.padEnd(10)} ${a.keyword.padEnd(40)} ${a.title}`);
    console.log(`\nShowing ${rows.length} of ${articles.length}`);
  },

  async unpublish(s) {
    const articles = await load("articles.json", []);
    const a = articles.find((x) => x.slug === s) ?? die(`no article "${s}"`);
    Object.assign(a, { status: "ready", manuallyUnpublished: true });
    await save("articles.json", articles);
    console.log(`unpublished ${s}`);
  },

  // Publishes one eligible article (mirrors "up to one per weekday" auto-publish), or a named slug.
  async publish(s) {
    const p = await project();
    const articles = await load("articles.json", []);
    const a = s ? articles.find((x) => x.slug === s) : articles.find((x) => x.status === "ready" && !x.manuallyUnpublished);
    if (!a) return console.log("nothing eligible to publish");
    if (!s && p.publishMode !== "auto") die("publishMode is manual; pass a slug or `set publishMode auto`");
    if (!s && new Date().getDay() === 0) return console.log("auto-publish skips Sundays");
    Object.assign(a, { status: "published", publishedAt: new Date().toISOString(), manuallyUnpublished: false });
    await save("articles.json", articles);
    if (process.env.PUBLISH_WEBHOOK_URL) {
      const res = await fetch(process.env.PUBLISH_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "article.published", slug: a.slug, title: a.title, description: a.description, markdown: a.markdown }) });
      console.log(`webhook ${res.status}`);
    }
    console.log(`published ${a.slug} (served at /api/v1/articles/${a.slug})`);
  },

  // ── Analytics (Google Search Console CSV export) + rewrite loop ──
  async "import-gsc"(file) {
    if (!file) die("usage: import-gsc <csv with columns page,query,clicks,impressions,position>");
    const [head, ...lines] = (await readFile(file, "utf8")).trim().split(/\r?\n/);
    const cols = head.toLowerCase().split(",").map((c) => c.trim().replace(/"/g, ""));
    const rows = lines.map((l) => {
      const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
      const r = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
      return { page: r.page ?? r["top pages"], query: r.query ?? r["top queries"], clicks: +r.clicks || 0, impressions: +r.impressions || 0, position: +r.position || null };
    });
    await save("gsc.json", { importedAt: new Date().toISOString(), rows });
    console.log(`imported ${rows.length} rows`);
  },

  async analytics() {
    const { rows = [] } = await load("gsc.json", {});
    if (!rows.length) die("no Search Console data; export from GSC and run `import-gsc <file>`");
    const byPage = {};
    for (const r of rows) { const pg = (byPage[r.page] ??= { clicks: 0, impressions: 0, pos: [] }); pg.clicks += r.clicks; pg.impressions += r.impressions; if (r.position) pg.pos.push(r.position); }
    console.table(Object.entries(byPage).map(([page, v]) => ({ page, clicks: v.clicks, impressions: v.impressions, avgPosition: v.pos.length ? +(v.pos.reduce((a, b) => a + b) / v.pos.length).toFixed(1) : null })).sort((a, b) => b.impressions - a.impressions));
  },

  // Rewrites published articles that get impressions but rank beyond page 1, using their real queries.
  async rewrite(minImpressions = "50") {
    const p = await project();
    const { rows = [] } = await load("gsc.json", {});
    if (!rows.length) die("rewrite needs Search Console data (`import-gsc`)");
    const articles = await load("articles.json", []);
    for (const a of articles.filter((x) => x.status === "published")) {
      const qs = rows.filter((r) => r.page?.replace(/\/$/, "").endsWith(`/${a.slug}`));
      const imp = qs.reduce((n, r) => n + r.impressions, 0);
      const pos = qs.length ? qs.reduce((n, r) => n + (r.position ?? 0) * r.impressions, 0) / (imp || 1) : null;
      if (imp < Number(minImpressions) || pos === null || pos <= 10) continue;
      const top = qs.sort((x, y) => y.impressions - x.impressions).slice(0, 10).map((r) => `${r.query} (pos ${r.position}, ${r.impressions} impr)`);
      a.markdown = await generateArticle(p, a, `This is a REWRITE. The current version averages position ${pos.toFixed(1)}. Real queries it shows up for:\n${top.join("\n")}\nCover these queries explicitly and improve depth.\nCurrent version:\n${a.markdown}`);
      a.rewrites = [...(a.rewrites ?? []), { at: new Date().toISOString(), avgPosition: +pos.toFixed(1), impressions: imp }];
      await save("articles.json", articles);
      console.log(`rewrote ${a.slug} (avg pos ${pos.toFixed(1)})`);
    }
  },

  // ── AI Search Visibility: topics → prompts → tracking ──
  async topics() {
    const p = await project();
    const topics = await findTopics(p);
    await save("topics.json", topics);
    for (const t of topics) console.log(`${t.relevance.padEnd(10)} ${t.topic}`);
    console.log("\nEdit data/topics.json to change relevance, then run `prompts`.");
  },

  async prompts(limit = "10") {
    const p = await project();
    const topics = (await load("topics.json", null)) ?? die("run `topics` first");
    const prompts = await buildPrompts(p, topics, Number(limit));
    await save("prompts.json", prompts);
    for (const q of prompts) console.log(`[${q.topic}] ${q.prompt}`);
  },

  async track() {
    const p = await project();
    const prompts = (await load("prompts.json", null)) ?? die("run `prompts` first");
    const run = await track(p, prompts);
    const runs = await load("visibility.json", []);
    runs.push(run);
    await save("visibility.json", runs);
    await commands.visibility();
  },

  async visibility() {
    const p = await project();
    const runs = await load("visibility.json", []);
    if (!runs.length) die("no tracking runs yet; run `track`");
    const s = summarize(runs.at(-1), p);
    console.log(`Visibility ${s.visibility}% · avg rank ${s.averageRank ?? "–"} · by platform ${JSON.stringify(s.byPlatform)}${s.errors ? ` · ${s.errors} errors` : ""}`);
    if (runs.length > 1) console.log(`Previous run: ${summarize(runs.at(-2), p).visibility}%`);
    console.log("\nShare of voice:"); for (const [n, c] of s.shareOfVoice) console.log(`  ${String(c).padStart(3)}  ${n}`);
    console.log("\nTop cited sources:"); for (const [d, c] of s.topSources) console.log(`  ${String(c).padStart(3)}  ${d}`);
  },

  // ── AI Visibility Actions ──
  async actions() {
    const p = await project();
    const report = await load("audit.json", null);
    const runs = await load("visibility.json", []);
    const s = runs.length ? summarize(runs.at(-1), p) : null;
    const articles = await load("articles.json", []);
    console.log(await llm(`Brand: ${JSON.stringify({ name: p.name, url: p.url, description: p.description })}
Audit grade ${report?.grade}; failing factors: ${JSON.stringify(report ? Object.values(report.factors).filter((f) => f.issues) : "audit not run")}; crawlability: ${JSON.stringify(report?.crawlability.issues)}
AI prompts where the brand is absent (and who appears instead): ${JSON.stringify(s?.gaps ?? "not tracked")}
Sources AI assistants cite most: ${JSON.stringify(s?.topSources ?? [])}
Existing content: ${articles.map((a) => `${a.title} [${a.status}]`).join("; ")}
List the 10 highest-impact AI Visibility Actions, ordered by impact/effort. Each: action, why (cite the data above), target (page, new page, or third-party source to get listed on).`));
  },

  async serve() { await import("./server.js"); },
};

const fn = commands[cmd];
if (!fn) die(`commands: ${Object.keys(commands).join(", ")}`);
await fn(...args).catch((e) => die(e.message));
