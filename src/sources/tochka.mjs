// Точка Банк: живой API с пагинацией и фильтром категории.
//
// Категорию по умолчанию НЕ задаём: слага "design" в их таксономии нет
// (категории — sales, it, editor, hr…), и запрос с ним всегда возвращал 0 —
// источник молча простаивал. Вакансий у Точки полсотни, дешевле забрать все
// и отдать на общий фильтр по ключевым словам: не сломается, когда они
// переименуют или заведут категорию под дизайн.
const API = "https://hr.tochka.com/api/v2/hr/vacancies/";
const MAX_PAGES = 10;

export async function fetchTochka(cfg) {
  const categories = cfg.tochka?.categories?.length ? cfg.tochka.categories : [""];
  const out = [];
  for (const cat of categories) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = cat ? `category=${encodeURIComponent(cat)}&` : "";
      const res = await fetch(`${API}?${q}page=${page}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`Точка HTTP ${res.status}`);
      const json = await res.json();
      const items = json.items || [];
      for (const v of items) {
        const k = (n) => Math.round(n / 1000) + "k";
        out.push({
          source: "tochka",
          id: `${v.mainCategory?.slug}/${v.slug}`,
          title: v.title,
          company: "Точка",
          url: v.customLink || `https://hr.tochka.com/vacancies/${v.mainCategory?.slug}/${v.slug}/`,
          salary: v.salaryTo ? `до ${k(v.salaryTo)} ₽` : v.salaryFrom ? `от ${k(v.salaryFrom)} ₽` : "",
          location: [v.city?.name || v.city, v.workFormat === "remotely" ? "удалённо" : ""].filter(Boolean).join(" · "),
          published: "",
        });
      }
      const { total = 0, pageSize = 20 } = json.meta || {};
      if (page * pageSize >= total || items.length === 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

export default { name: "tochka", fetch: fetchTochka };
