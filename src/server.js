// HTTP server: dashboard UI + its local control API, and the public publishing API
// mirroring RankAI's observed custom-site endpoints.
//   GET  /api/v1/articles?page=&limit=        summaries of published articles
//   GET  /api/v1/articles/:slug?format=html|markdown
//   GET  /sitemap.xml                         published article URLs
//   GET  /fixes.js                            technical SEO fixes snippet
//   GET  /                                    dashboard (public/index.html)
//   GET  /app/data                            all dashboard state (local only)
//   POST /app/project                         merge fields into the project profile
//   POST /app/save {name, value}              save edited topics/prompts
//   POST /app/run {cmd, args}                 run an allow-listed CLI command
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { load, save, markdownToHtml, frontMatter } from "./lib.js";
import { fixesScript } from "./fixes.js";
import { summarize } from "./visibility.js";

const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "127.0.0.1";
const CLI = new URL("./cli.js", import.meta.url).pathname;
const RUNNABLE = new Set(["init", "audit", "crawl", "fixes", "keywords", "add", "write", "publish", "unpublish", "rewrite", "topics", "prompts", "track", "actions", "set"]);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function articleUrl(project, a) {
  const base = project.url.replace(/\/$/, "");
  const path = (project.blogPath ?? "/blog").replace(/^\/?/, "/").replace(/\/$/, "");
  return `${base}${path}/${a.slug}`;
}

function body(a, format, strip) {
  let { body: md } = frontMatter(a.markdown);
  if (strip) md = md.replace(/^\s*#\s+.*\n/, "").replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*\n/, "");
  return format === "markdown" ? md : markdownToHtml(md);
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

function runCli(cmd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, cmd, ...args.map(String)], { maxBuffer: 16e6, timeout: 30 * 60e3 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }));
  });
}

async function appData() {
  const [project, audit, fixes, articles, topics, prompts, runs, gsc] = await Promise.all([
    load("project.json", null), load("audit.json", null), load("fixes.json", []), load("articles.json", []),
    load("topics.json", []), load("prompts.json", []), load("visibility.json", []), load("gsc.json", null),
  ]);
  if (audit) for (const p of audit.pages) delete p.text;
  return {
    project, audit, fixes, topics, prompts, gsc,
    articles: articles.map(({ markdown, ...a }) => ({ ...a, hasContent: !!markdown })),
    visibility: project && runs.length ? { latest: summarize(runs.at(-1), project), history: runs.map((r) => ({ at: r.at, visibility: summarize(r, project).visibility })) } : null,
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, type, data, cors = true) => { res.writeHead(code, { "content-type": type, ...(cors ? { "access-control-allow-origin": "*" } : {}) }); res.end(data); };
  const json = (code, data, cors) => send(code, "application/json", JSON.stringify(data), cors);
  try {
    // ── Dashboard + local control API (no CORS, loopback clients only) ──
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if ((url.pathname === "/" || url.pathname.startsWith("/app/")) && !local) return json(403, { error: "dashboard is local-only" }, false);
    if (url.pathname === "/") return send(200, "text/html", await readFile(new URL("../public/index.html", import.meta.url)), false);
    if (url.pathname === "/app/data") return json(200, await appData(), false);
    if (url.pathname === "/app/article") {
      const a = (await load("articles.json", [])).find((x) => x.slug === url.searchParams.get("slug"));
      return a ? json(200, { ...a, html: a.markdown ? body(a, "html", false) : "" }, false) : json(404, { error: "not found" }, false);
    }
    if (req.method === "POST" && url.pathname === "/app/project") {
      const p = await load("project.json", null);
      if (!p) return json(409, { error: "project not initialized" }, false);
      const patch = await readBody(req);
      await save("project.json", { ...p, ...patch });
      return json(200, { ok: true }, false);
    }
    if (req.method === "POST" && url.pathname === "/app/save") {
      const { name, value } = await readBody(req);
      if (!["topics.json", "prompts.json"].includes(name) || !Array.isArray(value)) return json(400, { error: "bad save" }, false);
      await save(name, value);
      return json(200, { ok: true }, false);
    }
    if (req.method === "POST" && url.pathname === "/app/run") {
      const { cmd, args = [] } = await readBody(req);
      if (!RUNNABLE.has(cmd)) return json(400, { error: `not allowed: ${cmd}` }, false);
      return json(200, await runCli(cmd, args), false);
    }

    // ── Public publishing API ──
    const project = await load("project.json", null);
    if (!project) return json(503, { error: "project not initialized" });
    const published = (await load("articles.json", [])).filter((a) => a.status === "published").sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    let m;
    if (url.pathname === "/api/v1/articles") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1)), limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
      const items = published.slice((page - 1) * limit, page * limit).map((a) => ({
        slug: a.slug, title: a.title, description: a.description, keyword: a.keyword, publishedAt: a.publishedAt, featuredImageUrl: a.featuredImageUrl ?? null, url: articleUrl(project, a),
      }));
      return json(200, { page, limit, total: published.length, items });
    }
    if ((m = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)$/))) {
      const a = published.find((x) => x.slug === m[1]);
      if (!a) return json(404, { error: "not found" });
      const format = url.searchParams.get("format") === "markdown" ? "markdown" : "html";
      return json(200, { slug: a.slug, title: a.title, description: a.description, publishedAt: a.publishedAt, featuredImageUrl: a.featuredImageUrl ?? null, format, content: body(a, format, project.stripTitleAndHero) });
    }
    if (url.pathname === "/sitemap.xml") {
      return send(200, "application/xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${published.map((a) => `<url><loc>${esc(articleUrl(project, a))}</loc><lastmod>${a.publishedAt.slice(0, 10)}</lastmod></url>`).join("\n")}\n</urlset>`);
    }
    if (url.pathname === "/fixes.js") return send(200, "text/javascript", fixesScript(await load("fixes.json", [])));
    json(404, { error: "not found" });
  } catch (e) {
    json(500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`rankengine dashboard on http://${HOST}:${PORT}`));
