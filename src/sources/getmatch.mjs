// getmatch: открытый JSON API. Сужаем на сервере до дизайн-специализаций
// (?sp=…) — getmatch классифицирует дизайн только как product_design и
// ux_writer, дев-вакансий там тысячи. Грейд в списке не приходит, но есть в
// детали вакансии (/api/offers/{id} → seniority) — добираем его штучно
// (после сужения это ~десяток запросов, не 700). Итог фильтруется в collect.mjs.
const API = "https://getmatch.ru/api/offers";
const PAGE = 100;
const MAX_PAGES = 12;
// getmatch → канонический грейд, понятный фильтру (см. GRADE_WORDS в filter.mjs)
const SENIORITY = { intern: "intern", junior: "junior", middle: "middle", senior: "senior", lead: "lead", head: "head" };

export async function fetchGetmatch(cfg) {
  const specs = cfg.getmatch?.specializations || ["product_design", "ux_writer"];
  const out = [];
  for (const sp of specs) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${API}?limit=${PAGE}&offset=${page * PAGE}&sp=${encodeURIComponent(sp)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`getmatch HTTP ${res.status}`);
      const json = await res.json();
      const levels = await enrichLevels(json.offers || []);
      for (const o of json.offers || []) {
        out.push({
          source: "getmatch",
          id: String(o.id),
          title: o.position || "",
          company: o.company?.name || "",
          url: o.url?.startsWith("http") ? o.url : `https://getmatch.ru${o.url || ""}`,
          salary: fmtSalary(o),
          location: fmtLocation(o.location_items),
          level: levels.get(o.id) || "",
          published: o.published_at,
        });
      }
      if ((page + 1) * PAGE >= (json.meta?.total || 0)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

// Грейд из детали каждой вакансии; ошибки/отсутствие поля — пустой уровень.
async function enrichLevels(offers) {
  const pairs = await Promise.all(offers.map(async (o) => {
    try {
      const res = await fetch(`${API}/${o.id}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) return [o.id, ""];
      const d = await res.json();
      return [o.id, SENIORITY[d.seniority] || d.seniority || ""];
    } catch {
      return [o.id, ""];
    }
  }));
  return new Map(pairs);
}

// [{label: "Москва", format: "hybrid"}, ...] → "удалённо (Россия), Москва…"
// Пишем именно «удалённо» — это слово распознаёт фильтр «Формат» в пульте.
function fmtLocation(items = []) {
  const fmt = { remote: "удалённо", hybrid: "гибрид", office: "офис" };
  const parts = items
    .filter((l) => !l.exclude)
    .map((l) => (l.format === "remote" ? `${fmt.remote} (${l.label})` : `${l.label} ${fmt[l.format] || ""}`.trim()));
  return parts.length > 2 ? `${parts.slice(0, 2).join(", ")}…` : parts.join(", ");
}

function fmtSalary(o) {
  const cur = { RUB: "₽", USD: "$", EUR: "€" }[o.salary_currency] || o.salary_currency || "";
  const k = (n) => Math.round(n / 1000) + "k";
  const from = o.salary_display_from, to = o.salary_display_to;
  if (from && to) return `${k(from)}–${k(to)} ${cur}`;
  if (from) return `от ${k(from)} ${cur}`;
  if (to) return `до ${k(to)} ${cur}`;
  return "";
}

export default { name: "getmatch", fetch: fetchGetmatch };
