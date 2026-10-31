import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

export const DATA = new URL("../data/", import.meta.url);
const ANTHROPIC_MODEL = process.env.RANK_MODEL ?? "claude-sonnet-5-5";

export async function load(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), "utf8")); }
  catch { return fallback; }
}

export async function save(name, value) {
  await mkdir(DATA, { recursive: true });
  await writeFile(new URL(name, DATA), JSON.stringify(value, null, 2));
}

async function post(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// AI platforms used for visibility tracking. Each is enabled only when its key
// (and, for non-Anthropic providers, an explicit model id) is configured.
export const PLATFORMS = {
  claude: {
    enabled: () => !!process.env.ANTHROPIC_API_KEY,
    async ask(prompt, { system, maxTokens = 4000 } = {}) {
      const body = await post("https://api.anthropic.com/v1/messages",
        { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        { model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] });
      return body.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    },
  },
  openai: {
    enabled: () => !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
    async ask(prompt, { system } = {}) {
      // OPENAI_BASE_URL also covers OpenAI-compatible providers (Groq, OpenRouter, Ollama).
      const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const body = await post(`${base}/chat/completions`,
        { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        { model: process.env.OPENAI_MODEL, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }] });
      return body.choices[0].message.content;
    },
  },
  gemini: {
    enabled: () => !!(process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL),
    async ask(prompt, { system } = {}) {
      const body = await post(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL}:generateContent`,
        { "x-goog-api-key": process.env.GEMINI_API_KEY },
        { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: [{ role: "user", parts: [{ text: prompt }] }] });
      return body.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    },
  },
};

// Writing/analysis model: LLM_PROVIDER, else the first configured platform.
export function llm(prompt, opts) {
  const id = process.env.LLM_PROVIDER ?? Object.keys(PLATFORMS).find((k) => PLATFORMS[k].enabled());
  const platform = PLATFORMS[id];
  if (!platform?.enabled()) throw new Error("No LLM configured: set ANTHROPIC_API_KEY, GEMINI_API_KEY + GEMINI_MODEL, or OPENAI_API_KEY + OPENAI_MODEL (+ OPENAI_BASE_URL)");
  return platform.ask(prompt, opts);
}

export async function llmJson(prompt, opts) {
  const ask = `${prompt}\n\nRespond with valid JSON only, no prose. Every object property needs a key.`;
  let text = await llm(ask, opts);
  for (let attempt = 0; ; attempt++) {
    const match = text.match(/[[{][\s\S]*[\]}]/);
    try {
      if (!match) throw new Error("no JSON found");
      return JSON.parse(match[0]);
    } catch (e) {
      // Smaller models sometimes emit invalid JSON; give the error back once.
      if (attempt) throw new Error(`LLM returned invalid JSON (${e.message}): ${text.slice(0, 200)}`);
      text = await llm(`${ask}\n\nYour previous reply was not valid JSON (${e.message}). Previous reply:\n${text.slice(0, 6000)}\n\nReturn the corrected JSON only.`, opts);
    }
  }
}

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

// Knowledge base: up to 25 text/Markdown/CSV/JSON files in data/knowledge/.
export async function knowledge(limitChars = 20000) {
  const dir = new URL("knowledge/", DATA);
  const files = (await readdir(dir).catch(() => [])).filter((f) => /\.(md|txt|csv|json)$/i.test(f)).slice(0, 25);
  let out = "";
  for (const f of files) out += `\n## ${f}\n${await readFile(new URL(f, dir), "utf8")}`;
  return out.slice(0, limitChars);
}

// Minimal Markdown -> HTML for the articles API (headings, lists, emphasis, links, paragraphs).
export function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const out = [];
  let list = null, para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`), (para = []);
    if (list) out.push(`</${list}>`), (list = null);
  };
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)/), ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) {
      if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`), (para = []);
      const tag = ul ? "ul" : "ol";
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else if (!line.trim()) flush();
    else { if (list) out.push(`</${list}>`), (list = null); para.push(line.trim()); }
  }
  flush();
  return out.join("\n");
}

export function frontMatter(md) {
  // Tolerate code fences and empty front-matter blocks some models emit before the real one.
  md = md.replace(/^\s*```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").replace(/^\s*(?:---\s*\n\s*)+(?=---\s*\n\S)/, "");
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta = Object.fromEntries(m[1].split("\n").map((l) => l.match(/^(\w+):\s*"?(.*?)"?\s*$/)).filter(Boolean).map((x) => [x[1], x[2]]));
  return { meta, body: md.slice(m[0].length) };
}
