// LinkedIn: публичный ГОСТЕВОЙ эндпоинт объявлений о вакансиях (jobs-guest).
// Это НЕ лента и НЕ твой аккаунт — открытые job-постинги, отдаются без логина,
// как их видит незалогиненный посетитель. Аккаунт не участвует → бана нет.
// Возвращает HTML-фрагмент с карточками; парсим регэкспами (stdlib, без cheerio).
//
// Параметры фильтра (config.linkedin):
//   keywords   — поисковый запрос (по умолчанию склеиваем из cfg.keywords)
//   location   — "Russia" | "Worldwide" | город (по умолчанию Worldwide)
//   remoteOnly — true → только удалёнка (f_WT=2)
//   sinceHours — окно свежести в часах (по умолчанию 168 = неделя)
const API = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const PAGE = 10;
const MAX_PAGES = 4;

export async function fetchLinkedin(cfg) {
  const lcfg = cfg.linkedin || {};
  const keywords = lcfg.keywords || (cfg.keywords || []).slice(0, 4).join(" OR ");
  const location = lcfg.location || "Worldwide";
  const sinceSec = Math.round((lcfg.sinceHours ?? 168) * 3600);

  const base = new URLSearchParams({ keywords, location, f_TPR: `r${sinceSec}` });
  if (lcfg.remoteOnly) base.set("f_WT", "2");

  const byId = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    base.set("start", String(page * PAGE));
    const res = await fetch(`${API}?${base}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
    });
    if (res.status === 429) throw new Error("LinkedIn 429 (частим — увеличь интервал)");
    if (!res.ok) throw new Error(`LinkedIn HTTP ${res.status}`);
    const html = await res.text();
    const cards = parseCards(html);
    for (const c of cards) byId.set(c.id, c);
    if (cards.length < PAGE) break; // страница неполная — дальше пусто
    await new Promise((r) => setTimeout(r, 800)); // LinkedIn чувствителен к частоте
  }
  return [...byId.values()];
}

function parseCards(html) {
  const out = [];
  // карточки разделены <li>…; берём title, company, ссылку view, локацию
  for (const block of html.split(/<li[ >]/).slice(1)) {
    const url = (block.match(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const id = url && (url.match(/-(\d+)$/) || [])[1];
    if (!url || !id) continue;
    const title = clean(block.match(/base-search-card__title">([\s\S]*?)<\/h3>/));
    if (!title) continue;
    out.push({
      source: "linkedin",
      id,
      title,
      company: clean(block.match(/base-search-card__subtitle">([\s\S]*?)<\/h4>/)),
      url: url.split("?")[0],
      salary: "",
      location: clean(block.match(/job-search-card__location">([\s\S]*?)<\/span>/)),
      published: (block.match(/datetime="([^"]+)"/) || [])[1] || "",
    });
  }
  return out;
}

function clean(m) {
  if (!m) return "";
  return m[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default { name: "linkedin", fetch: fetchLinkedin };
