// Магнит (magnit.tech): открытый JSON API их SPA. Вакансий немного (~45, все
// ИТ), фильтра по направлению нет — забираем всё, центральный фильтр отберёт.
const API = "https://magnit.tech/api/v1/vacancy";
const PAGE = 100;
const MAX_PAGES = 3;

export async function fetchMagnit(cfg) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${API}?per_page=${PAGE}&page=${page}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
    });
    if (!res.ok) throw new Error(`Магнит HTTP ${res.status}`);
    const json = await res.json();
    for (const v of json.results || []) {
      out.push({
        source: "magnit",
        id: String(v.id),
        title: v.title,
        company: "Магнит",
        url: `https://magnit.tech/vacancies/${v.id}`,
        salary: "",
        location: (v.work_formats || []).map((w) => w?.name).filter(Boolean).join("; "),
        published: "",
      });
    }
    if (!json.meta?.has_more_pages) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

export default { name: "magnit", fetch: fetchMagnit };
