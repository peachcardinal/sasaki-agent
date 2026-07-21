// X5 Tech (x5.tech): вакансии вшиты в SSR-HTML как escaped-JSON (как у 2ГИС).
// Пагинация ?page=N, totalPages лежит в том же пейлоаде. Вакансий немного
// (~20), фильтра нет — забираем всё, центральный фильтр отберёт.
const PAGE_URL = "https://x5.tech/vacancy";
const MAX_PAGES = 10;

export async function fetchX5(cfg) {
  const out = [];
  const seen = new Set();
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    const res = await fetch(`${PAGE_URL}${page > 1 ? `?page=${page}` : ""}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
    });
    if (!res.ok) throw new Error(`X5 HTTP ${res.status}`);
    const html = (await res.text()).replaceAll('\\"', '"');
    totalPages = parseInt((html.match(/"totalPages":(\d+)/) || [])[1], 10) || totalPages;
    for (const v of extractVacancies(html)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({
        source: "x5",
        id: v.id,
        title: v.name,
        company: "X5 Tech",
        url: `https://x5.tech/vacancy/${v.id}`,
        salary: "",
        location: fmtLocation(v),
        published: v.createdAt || "",
      });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

// Объекты вакансий в пейлоаде: {"id":"<uuid>","externalId":...,"name":...}.
// Вырезаем сбалансированный по скобкам кусок от каждого такого якоря.
function extractVacancies(html) {
  const items = [];
  const re = /\{"id":"[0-9a-f-]{36}","externalId"/g;
  let m;
  while ((m = re.exec(html))) {
    let depth = 0, end = -1;
    for (let i = m.index; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    try {
      items.push(JSON.parse(html.slice(m.index, end + 1)));
    } catch { /* побочный объект с той же формой — пропускаем */ }
  }
  return items;
}

function fmtLocation(v) {
  const fmt = v.isRemote ? "удалённо" : v.isHybrid ? "гибрид" : v.isOffice ? "офис" : "";
  return [v.city, fmt].filter(Boolean).join(" · ");
}

export default { name: "x5", fetch: fetchX5 };
