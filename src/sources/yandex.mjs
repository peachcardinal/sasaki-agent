// Яндекс Работа: открытый JSON API каталога вакансий, пагинация курсором.
// Даты публикации в списке нет — она лежит в детальной карточке
// /api/publications/<id> (published_at); добываем её только для новых id
// через кэш data/pub-dates.json (см. lib/pubdates.mjs).
import { withPubDates } from "../lib/pubdates.mjs";

const API = "https://yandex.ru/jobs/api/publications";
const MAX_PAGES = 20;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" };

export async function fetchYandex(cfg) {
  const professions = cfg.yandex?.professions || ["designer-uxui", "designer"];
  const base = professions.map((p) => `professions=${encodeURIComponent(p)}`).join("&");
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${API}?${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`Яндекс HTTP ${res.status}`);
    const json = await res.json();
    for (const r of json.results || []) {
      out.push({
        source: "yandex",
        id: String(r.id),
        title: r.title,
        company: ["Яндекс", r.public_service?.name].filter(Boolean).join(" · "),
        url: `https://yandex.ru/jobs/vacancies/${r.publication_slug_url}`,
        salary: "",
        location: [
          (r.vacancy?.cities || []).map((c) => c.name).join(", "),
          (r.vacancy?.work_modes || []).map((m) => m.name.toLowerCase()).join("/"),
        ].filter(Boolean).join(" · "),
        published: "",
      });
    }
    // next приходит с внутренним хостом — берём из него только cursor
    if (!json.next) break;
    cursor = new URL(json.next).searchParams.get("cursor");
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return withPubDates("yandex", out, async (item) => {
    const res = await fetch(`${API}/${item.id}`, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).published_at || ""; // "2026-07-17"
  });
}

export default { name: "yandex", fetch: fetchYandex };
