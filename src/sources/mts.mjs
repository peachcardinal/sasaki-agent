// МТС (job.mts.ru): Strapi-бэкенд, открытый JSON API без ключей.
// Категорийные фильтры API игнорирует, зато работает фильтр по названию:
// filters[title][$containsi]. Запросы — в config.json → mts.queries.
const API = "https://job.mts.ru/api/v2/vacancies";
const PAGE = 100;
const MAX_PAGES = 3;

export async function fetchMts(cfg) {
  const queries = cfg.mts?.queries || ["дизайн", "design"];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({
        "filters[title][$containsi]": q,
        "pagination[pageSize]": String(PAGE),
        "pagination[page]": String(page),
        sort: "publishedAt:desc",
      });
      const res = await fetch(`${API}?${params}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`МТС HTTP ${res.status}`);
      const json = await res.json();
      for (const v of json.data || []) {
        if (seen.has(v.slug)) continue;
        seen.add(v.slug);
        out.push({
          source: "mts",
          id: String(v.slug),
          title: v.title,
          company: "МТС",
          url: `https://job.mts.ru/vacancy/${v.slug}`,
          salary: fmtSalary(v),
          location: fmtLocation(v),
          published: v.publishedAt || "",
        });
      }
      const total = json.meta?.pagination?.total || 0;
      if (page * PAGE >= total) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

function fmtSalary(v) {
  const cur = (typeof v.currency === "object" ? v.currency?.title || v.currency?.code : v.currency) || "₽";
  const n = (x) => Number(x).toLocaleString("ru-RU");
  if (v.salaryFrom && v.salaryTo) return `${n(v.salaryFrom)}–${n(v.salaryTo)} ${cur}`;
  if (v.salaryFrom) return `от ${n(v.salaryFrom)} ${cur}`;
  if (v.salaryTo) return `до ${n(v.salaryTo)} ${cur}`;
  return "";
}

function fmtLocation(v) {
  const region = typeof v.region === "object" ? v.region?.title : v.region;
  // названия форматов у МТС («В офисе», «Гибрид», «Удаленная работа»)
  // содержат слова, которые понимает фильтр «Формат» — отдаём как есть
  const formats = (v.workFormats || []).map((w) => w?.title).filter(Boolean);
  return [region, formats.join("/")].filter(Boolean).join(" · ");
}

export default { name: "mts", fetch: fetchMts };
