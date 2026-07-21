// Хабр Карьера: официальный RSS, по запросу на каждое ключевое слово.
const RSS_URL = "https://career.habr.com/vacancies/rss";

export async function fetchHabr(cfg) {
  const byId = new Map();
  const remoteIds = new Set();
  // второй проход с remote=true — RSS формата работы не отдаёт, поэтому
  // удалёнку вычисляем разницей выдач и кладём в location для фильтра «Формат»
  for (const remote of [false, true]) {
    for (const kw of cfg.keywords) {
      const qs = `q=${encodeURIComponent(kw)}&type=all${remote ? "&remote=true" : ""}`;
      const res = await fetch(`${RSS_URL}?${qs}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) continue;
      for (const item of parseRss(await res.text())) {
        if (remote) remoteIds.add(item.id);
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
      await new Promise((r) => setTimeout(r, 300)); // не долбим
    }
  }
  for (const id of remoteIds) {
    const item = byId.get(id);
    item.location = [item.location, "удалённо"].filter(Boolean).join(" · ");
  }
  return [...byId.values()];
}

function parseRss(xml) {
  return xml
    .split("<item>")
    .slice(1)
    .map((chunk) => {
      const rawTitle = decode(tag(chunk, "title"));
      // Формат: Требуется «Дизайн-лид» (Москва, от 150 000 ₽) — в скобках
      // вперемешку город и вилка; зарплату отделяем в своё поле
      const m = rawTitle.match(/«(.+)»(?:\s*\((.+)\))?/);
      const parts = (m?.[2] || "").split(", ");
      const isSalary = (s) => /^(от|до)\s|\d\s?\d{3}|[₽$€]/.test(s);
      return {
        source: "habr",
        id: tag(chunk, "guid"),
        title: m ? m[1] : rawTitle,
        company: decode(tag(chunk, "author")),
        url: tag(chunk, "link"),
        salary: parts.filter(isSalary).join(", "),
        location: parts.filter((p) => p && !isSalary(p)).join(", "),
        level: levelFromDescription(tag(chunk, "description")),
        published: tag(chunk, "pubDate"),
      };
    })
    .filter((i) => i.id && i.url);
}

// Грейд из «Требуемые навыки» в description: среди хештегов навыков Хабр отдаёт
// и квалификацию (#middle, #senior, …) — в самом заголовке её обычно нет.
export function levelFromDescription(desc) {
  const found = [...(desc || "").matchAll(/#(intern|trainee|junior|middle|senior|lead|тимлид|head)(?![\w/])/gi)]
    .map((m) => m[1].toLowerCase());
  return [...new Set(found)].join(" ");
}

const tag = (s, name) =>
  (s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]?.trim() || "";

const decode = (s) =>
  s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");

export default { name: "habr", fetch: fetchHabr };
