// AI Search Visibility: topics -> prompts -> tracking runs across enabled AI platforms.
import { PLATFORMS, llmJson } from "./lib.js";

const PROMPTS_PER_RELEVANCE = { core: 5, adjacent: 3, peripheral: 1 };

export async function findTopics(profile) {
  return llmJson(`Business profile: ${JSON.stringify(profile)}
Identify 6-10 topic groups buyers research that relate to this business.
Return [{"topic","relevance":"core"|"adjacent"|"peripheral","why"}] where core = exactly what it sells.`);
}

export async function buildPrompts(profile, topics, limit) {
  const want = topics.map((t) => ({ topic: t.topic, count: PROMPTS_PER_RELEVANCE[t.relevance] ?? 1 }));
  const prompts = await llmJson(`Business: ${profile.name} (${profile.country}, ${profile.language}). Audiences: ${profile.audiences.join(", ")}.
For each topic write the given number of natural questions a buyer would type into ChatGPT or Gemini.
Never name ${profile.name}. Mix "best X for Y", comparisons, and how-to questions.
Topics: ${JSON.stringify(want)}
Return [{"topic","prompt"}].`);
  // Smaller models vary the shape: a wrapper object, nested question lists, or other field names.
  const list = Array.isArray(prompts) ? prompts : Object.values(prompts).find(Array.isArray) ?? [];
  return list
    .flatMap((q) => Array.isArray(q?.questions ?? q?.prompts) ? (q.questions ?? q.prompts).map((x) => ({ topic: q.topic, prompt: x?.prompt ?? x?.question ?? x })) : [q])
    .map((q) => (typeof q === "string" ? { topic: "", prompt: q } : { topic: q.topic ?? "", prompt: q.prompt ?? q.question ?? q.text ?? q.query }))
    .filter((q) => typeof q.prompt === "string" && q.prompt.trim())
    .slice(0, limit);
}

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
const brandNames = (profile) => [
  { name: profile.name, domain: domainOf(profile.url), own: true },
  ...profile.competitors.map((c) => ({ name: c.name ?? domainOf(c.url ?? c) ?? c, domain: domainOf(c.url ?? c), own: false })),
];

function analyze(answer, brands) {
  const lower = answer.toLowerCase();
  const positions = brands.map((b) => {
    const keys = [b.name, b.domain, b.domain?.split(".")[0]].filter((k) => k && k.length > 2).map((k) => k.toLowerCase());
    const idx = Math.min(...keys.map((k) => lower.indexOf(k)).filter((i) => i >= 0));
    return { ...b, at: Number.isFinite(idx) ? idx : null };
  }).filter((b) => b.at !== null).sort((a, b) => a.at - b.at);
  const sources = [...new Set((answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).map(domainOf).filter(Boolean))];
  return {
    mentioned: positions.some((p) => p.own),
    rank: positions.findIndex((p) => p.own) + 1 || null,
    mentions: positions.map((p) => p.name),
    sources,
  };
}

export async function track(profile, prompts) {
  const platforms = Object.entries(PLATFORMS).filter(([, p]) => p.enabled());
  const brands = brandNames(profile);
  const run = { at: new Date().toISOString(), platforms: platforms.map(([id]) => id), results: [] };
  for (const { topic, prompt } of prompts) {
    for (const [id, platform] of platforms) {
      try {
        const answer = await platform.ask(prompt, { system: "Answer as you would for a typical user. When you recommend products or rely on sources, include their URLs.", maxTokens: 1500 });
        run.results.push({ platform: id, topic, prompt, ...analyze(answer, brands) });
      } catch (e) {
        run.results.push({ platform: id, topic, prompt, error: e.message });
      }
    }
  }
  return run;
}

export function summarize(run, profile) {
  const ok = run.results.filter((r) => !r.error);
  const share = {}, sources = {};
  for (const r of ok) {
    for (const m of r.mentions) share[m] = (share[m] ?? 0) + 1;
    for (const s of r.sources) sources[s] = (sources[s] ?? 0) + 1;
  }
  const own = ok.filter((r) => r.mentioned);
  return {
    at: run.at,
    visibility: ok.length ? Math.round((own.length / ok.length) * 100) : 0,
    averageRank: own.length ? +(own.reduce((n, r) => n + r.rank, 0) / own.length).toFixed(1) : null,
    shareOfVoice: Object.entries(share).sort((a, b) => b[1] - a[1]),
    topSources: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 15),
    byPlatform: Object.fromEntries(run.platforms.map((p) => {
      const rs = ok.filter((r) => r.platform === p);
      return [p, rs.length ? Math.round((rs.filter((r) => r.mentioned).length / rs.length) * 100) : 0];
    })),
    gaps: ok.filter((r) => !r.mentioned).map((r) => ({ platform: r.platform, prompt: r.prompt, competitors: r.mentions.filter((m) => m !== profile.name) })),
    errors: run.results.filter((r) => r.error).length,
  };
}
