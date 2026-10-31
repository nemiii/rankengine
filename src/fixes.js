// Technical SEO "code changes": per-page fixes grouped by RankAI's categories,
// plus a drop-in script that applies enabled fixes in the browser.
import { llmJson } from "./lib.js";

export const CATEGORIES = [
  "optimizeForAiSearch", "optimizeTitle", "optimizeDescription", "addOpenGraph", "addCanonical",
  "modifyLinkTarget", "addLinkTitle", "addImageAlt", "removeBrokenLinks", "addInternalLinks",
];

const fileLabel = (src = "") => decodeURIComponent(src.split("/").pop().split("?")[0].replace(/\.[a-z0-9]+$/i, "")).replace(/[-_]+/g, " ").trim();

export async function buildFixes(report, profile) {
  const pages = report.pages.filter((p) => p.findings && p.status < 400);
  // One LLM pass for the judgement-based fixes (titles, descriptions, AI-search FAQ, internal links).
  const ask = pages.map((p) => ({ url: p.url, title: p.title, description: p.description, h1: p.h1, text: p.text.slice(0, 1200) }));
  const ai = await llmJson(`Business: ${profile.name} — ${profile.description}
Site pages: ${JSON.stringify(ask)}
For each page return an object keyed by url with:
"title" (<=60 chars, includes the page's main keyword), "description" (<=155 chars),
"faq" (3 question/answer pairs a buyer would ask an AI assistant about this page, answers <=50 words, factual from the page only),
"internalLinks" (up to 3 {anchor, href} pointing to OTHER urls in this list that are topically related).`, { maxTokens: 8000 });

  const fixes = [];
  const add = (page, category, change) => fixes.push({ id: `${fixes.length + 1}`, page: page.url, path: new URL(page.url).pathname, category, enabled: true, applied: false, ...change });
  for (const p of pages) {
    const f = p.findings, s = ai[p.url] ?? {};
    if (f.title.length && s.title) add(p, "optimizeTitle", { op: "setTitle", value: s.title, before: p.title });
    if (f.description.length && s.description) add(p, "optimizeDescription", { op: "setMeta", name: "description", value: s.description, before: p.description });
    const og = { "og:title": s.title ?? p.title, "og:description": s.description ?? p.description, "og:url": p.url, "og:type": "website", "og:image": profile.ogImage };
    for (const { missing } of f.openGraph) if (og[missing]) add(p, "addOpenGraph", { op: "setMeta", property: missing, value: og[missing] });
    if (f.canonical.length) add(p, "addCanonical", { op: "setCanonical", value: p.url });
    for (const { href } of f.linkTarget) add(p, "modifyLinkTarget", { op: "setLinkAttrs", href, attrs: { target: "_blank", rel: "noopener" } });
    for (const { href, text } of f.linkTitle) if (text) add(p, "addLinkTitle", { op: "setLinkAttrs", href, attrs: { title: text } });
    for (const { src } of f.imageAlt) if (src) add(p, "addImageAlt", { op: "setImageAlt", src, value: fileLabel(src) || profile.name });
    for (const { href } of f.brokenLinks) add(p, "removeBrokenLinks", { op: "unlink", href: href ?? "" });
    if (f.internalLinks.length) for (const l of (s.internalLinks ?? []).filter((l) => l.href && new URL(l.href, p.url).href !== p.url)) add(p, "addInternalLinks", { op: "appendLink", href: l.href, anchor: l.anchor });
    if (s.faq?.length) add(p, "optimizeForAiSearch", {
      op: "addJsonLd",
      value: { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: s.faq.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })) },
    });
    if (f.structuredData.length) add(p, "optimizeForAiSearch", {
      op: "addJsonLd",
      value: { "@context": "https://schema.org", "@type": "WebPage", name: s.title ?? p.title, url: p.url, publisher: { "@type": "Organization", name: profile.name, url: profile.url } },
    });
  }
  return fixes;
}

// Browser script: <script src="https://YOUR-RANKENGINE/fixes.js" defer></script>
export function fixesScript(fixes) {
  const byPath = {};
  for (const f of fixes.filter((x) => x.enabled)) (byPath[f.path] ??= []).push(f);
  return `(function(){var F=${JSON.stringify(byPath)}[location.pathname]||[];var h=document.head;
function meta(k,v,n){var s=n?'meta[name="'+k+'"]':'meta[property="'+k+'"]';var m=h.querySelector(s);if(!m){m=document.createElement("meta");m.setAttribute(n?"name":"property",k);h.appendChild(m);}m.setAttribute("content",v);}
function links(href){return Array.prototype.filter.call(document.querySelectorAll("a"),function(a){return (a.getAttribute("href")||"")===href||a.href===href;});}
F.forEach(function(f){switch(f.op){
case"setTitle":document.title=f.value;break;
case"setMeta":f.name?meta(f.name,f.value,1):meta(f.property,f.value,0);break;
case"setCanonical":if(!h.querySelector('link[rel="canonical"]')){var l=document.createElement("link");l.rel="canonical";l.href=f.value;h.appendChild(l);}break;
case"setLinkAttrs":links(f.href).forEach(function(a){for(var k in f.attrs)if(!a.getAttribute(k))a.setAttribute(k,f.attrs[k]);});break;
case"setImageAlt":Array.prototype.forEach.call(document.querySelectorAll("img"),function(i){if((i.getAttribute("src")||"")===f.src&&!i.alt)i.alt=f.value;});break;
case"unlink":links(f.href).forEach(function(a){a.removeAttribute("href");});break;
case"appendLink":var n=document.querySelector("main")||document.body;var a=document.createElement("a");a.href=f.href;a.textContent=f.anchor;a.title=f.anchor;var p=document.createElement("p");p.appendChild(a);n.appendChild(p);break;
case"addJsonLd":var s=document.createElement("script");s.type="application/ld+json";s.text=JSON.stringify(f.value);h.appendChild(s);break;}});})();`;
}
