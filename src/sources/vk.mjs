// VK (team.vk.company): Next.js, вакансии вшиты в SSR-HTML как __NEXT_DATA__.
// Фильтр — query-параметр specialty (273 = «Дизайн», полный список — в
// props.pageProps.filters.specialities той же страницы). Дат публикации нет:
// в списке поля даты отсутствуют, а на странице вакансии meta datePosted —
// SEO-фейк (у ВСЕХ вакансий, включая годовалые id, всегда сегодняшняя дата;
// проверено по всем текущим дизайн-вакансиям) — published остаётся пустым.
const BASE = "https://team.vk.company/vacancy/";
const PAGE_SIZE = 25;
const MAX_PAGES = 5;

export async function fetchVk(cfg) {
  const specialties = cfg.vk?.specialties || [273];
  const seen = new Set();
  const out = [];
  for (const sp of specialties) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}?specialty=${sp}${page > 1 ? `&page=${page}` : ""}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`VK HTTP ${res.status}`);
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) throw new Error("VK: __NEXT_DATA__ не найден (изменилась вёрстка?)");
      const pp = JSON.parse(m[1])?.props?.pageProps || {};
      const items = pp.initialVacancies || [];
      for (const v of items) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push({
          source: "vk",
          id: String(v.id),
          title: v.title,
          company: v.group?.name ? `VK · ${v.group.name}` : "VK",
          url: `https://team.vk.company/vacancy/${v.id}/`,
          salary: "",
          location: fmtLocation(v),
          published: "",
        });
      }
      const total = pp.initialTotalCount || 0;
      if (items.length === 0 || page * PAGE_SIZE >= total) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

// Форматы VK («Офисный», «Дистанционный», «Комбинированный», «гибкий») →
// слова, которые понимает фильтр «Формат».
const FORMAT = {
  офисный: "офис",
  дистанционный: "удалённо",
  комбинированный: "гибрид",
  гибкий: "гибрид",
};

function fmtLocation(v) {
  const raw = (v.work_format || "").toLowerCase();
  const fmt = v.remote ? "удалённо" : FORMAT[raw] || v.work_format || "";
  return [v.town?.name, fmt].filter(Boolean).join(" · ");
}

export default { name: "vk", fetch: fetchVk };
