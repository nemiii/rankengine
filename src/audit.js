// Crawl a site (same origin, bounded) and evaluate the 10 technical SEO factors
// RankAI's Website Audit reports, plus robots/sitemap crawlability.
const all = (html, re) => [...html.matchAll(re)];
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const FACTORS = {
  title: "Title should be relevant and contain keywords",
  description: "Description should be relevant and contain keywords",
  openGraph: "Open Graph tags should be present for better social media sharing",
  canonical: "Page should have one canonical tag",
  linkTarget: "External links should have a target attribute",
  linkTitle: "Links should have descriptive title attributes",
  imageAlt: "Images should have descriptive alt text",
  brokenLinks: "Links should have valid hrefs without broken or empty URLs",
  internalLinks: "Page should have at least 3 internal links",
  structuredData: "Page should have structured data (schema.org markup)",
};

function inspectPage(url, html, status) {
  const origin = new URL(url).origin;
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metas = all(html, /<meta\b[^>]*>/gi).map((m) => m[0]);
  const meta = (key) => metas.find((t) => (attr(t, "name") ?? attr(t, "property")) === key);
  const description = meta("description") ? attr(meta("description"), "content") ?? "" : "";
  const links = all(html, /<a\b([^>]*)>([\s\S]*?)<\/a>/gi).map((m) => ({ tag: m[0].slice(0, m[0].indexOf(">") + 1), text: strip(m[2]) }));
  const images = all(html, /<img\b[^>]*>/gi).map((m) => m[0]);
  const text = strip(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " "));

  const hrefs = links.map((l) => ({ ...l, href: attr(l.tag, "href") }));
  const resolved = hrefs.map((l) => { try { return { ...l, abs: new URL(l.href, url) }; } catch { return { ...l, abs: null }; } });
  const internal = resolved.filter((l) => l.abs?.origin === origin);
  const external = resolved.filter((l) => l.abs && /^https?:$/.test(l.abs.protocol) && l.abs.origin !== origin);

  const findings = {
    title: !title || title.length > 60 ? [{ current: title || null }] : [],
    description: !description || description.length > 160 ? [{ current: description || null }] : [],
    openGraph: ["og:title", "og:description", "og:image", "og:url", "og:type"].filter((k) => !meta(k)).map((k) => ({ missing: k })),
    canonical: (() => { const n = all(html, /<link\b[^>]*rel=["']canonical["'][^>]*>/gi).length; return n === 1 ? [] : [{ count: n }]; })(),
    linkTarget: external.filter((l) => !attr(l.tag, "target")).map((l) => ({ href: l.abs.href })),
    linkTitle: hrefs.filter((l) => l.href && !attr(l.tag, "title")).map((l) => ({ href: l.href, text: l.text })),
    imageAlt: images.filter((t) => !attr(t, "alt")?.trim()).map((t) => ({ src: attr(t, "src") })),
    brokenLinks: hrefs.filter((l) => !l.href?.trim() || l.href === "#" || /^javascript:/i.test(l.href)).map((l) => ({ href: l.href ?? null, text: l.text })),
    internalLinks: new Set(internal.map((l) => l.abs.pathname)).size < 3 ? [{ count: new Set(internal.map((l) => l.abs.pathname)).size }] : [],
    structuredData: /application\/ld\+json/i.test(html) ? [] : [{ missing: "JSON-LD" }],
  };
  return {
    url, status, title, description, words: text.split(" ").length,
    h1: all(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map((m) => strip(m[1])),
    findings, text: text.slice(0, 4000),
    internalUrls: internal.map((l) => { const u = new URL(l.abs); u.hash = ""; u.search = ""; return u.href; }),
  };
}

export async function crawlability(origin) {
  const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot"];
  const issues = [];
  const robotsRes = await fetch(`${origin}/robots.txt`).catch(() => null);
  const robots = robotsRes?.ok ? await robotsRes.text() : null;
  const sitemaps = [];
  if (!robots) issues.push("robots.txt missing or unreachable");
  else {
    // Group rules by user-agent; flag any group that disallows "/" for a known crawler or "*".
    let agents = [], lastWasAgent = false;
    for (const raw of robots.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      if (line.startsWith("<")) { issues.push("robots.txt contains HTML (server returns a web page for part or all of it)"); break; }
      const [k, ...rest] = line.split(":");
      const key = k?.toLowerCase(), val = rest.join(":").trim();
      if (key === "user-agent") { agents = lastWasAgent ? [...agents, val] : [val]; lastWasAgent = true; continue; }
      lastWasAgent = false;
      if (key === "disallow" && val === "/") {
        for (const a of agents) {
          if (a === "*") issues.push("robots.txt disallows the entire site for all crawlers");
          else if (AI_BOTS.some((b) => b.toLowerCase() === a.toLowerCase())) issues.push(`robots.txt blocks ${a}`);
        }
      }
      if (key === "sitemap") sitemaps.push(val);
      else if (line && !["allow", "disallow", "crawl-delay", "host", "user-agent", "content-signal", ""].includes(key)) issues.push(`robots.txt: unknown directive "${k}"`);
    }
  }
  if (!sitemaps.length) sitemaps.push(`${origin}/sitemap.xml`);
  let sitemapUrls = 0;
  for (const s of sitemaps) {
    const res = await fetch(s).catch(() => null);
    const body = res?.ok ? await res.text() : "";
    if (!res?.ok) issues.push(`sitemap unreachable: ${s}`);
    else if (!/<(urlset|sitemapindex)\b/.test(body)) issues.push(`sitemap is not valid XML sitemap: ${s}`);
    else {
      const n = (body.match(/<loc>/g) ?? []).length;
      if (!n) issues.push(`sitemap has no URLs: ${s}`);
      sitemapUrls += n;
    }
  }
  const llmsRes = await fetch(`${origin}/llms.txt`).catch(() => null);
  const llmsTxt = !!llmsRes?.ok && !/text\/html/.test(llmsRes.headers.get("content-type") ?? "");
  if (!llmsTxt) issues.push("llms.txt missing (optional, helps AI assistants)");
  return { checkedAt: new Date().toISOString(), robotsTxt: robots !== null, sitemaps, sitemapUrls, llmsTxt, issues };
}

export function grade(pages) {
  const failing = Object.keys(FACTORS).filter((f) => pages.some((p) => p.findings?.[f]?.length));
  const score = 1 - failing.length / Object.keys(FACTORS).length;
  return ["F", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"][Math.round(score * 10)];
}

export async function audit(start, { maxPages = 25 } = {}) {
  const origin = new URL(start).origin;
  const first = new URL(start).href, queue = [first], seen = new Set(queue), pages = [], status = {};
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    let res, html;
    try { res = await fetch(url, { redirect: "follow" }); html = await res.text(); }
    catch (e) { status[url] = 0; pages.push({ url, status: 0, error: e.message, findings: {} }); continue; }
    status[url] = res.status;
    if (!/text\/html/.test(res.headers.get("content-type") ?? "")) continue;
    const page = inspectPage(url, html, res.status);
    pages.push(page);
    for (const next of page.internalUrls) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  // Internal links that resolved to 4xx/5xx among crawled pages count as broken.
  for (const p of pages) for (const u of p.internalUrls ?? []) if (status[u] >= 400 || status[u] === 0) p.findings.brokenLinks.push({ href: u, status: status[u] });
  for (const p of pages) delete p.internalUrls;
  const factors = Object.fromEntries(Object.entries(FACTORS).map(([k, label]) => [k, { label, issues: pages.reduce((n, p) => n + (p.findings?.[k]?.length ?? 0), 0) }]));
  return {
    origin, crawledAt: new Date().toISOString(),
    coverage: { crawled: pages.length, discovered: seen.size, maxPages },
    grade: grade(pages), factors, crawlability: await crawlability(origin), pages,
  };
}
