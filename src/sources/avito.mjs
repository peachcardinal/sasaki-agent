// Авито (career.avito.com, Bitrix): AJAX-фильтр отдаёт JSON {html: "..."}.
// Даты публикации в карточках списка нет — она есть на странице вакансии
// (JSON-LD "datePosted"); добываем её только для новых id через кэш
// data/pub-dates.json (см. lib/pubdates.mjs).
import { withPubDates } from "../lib/pubdates.mjs";

const API = "https://career.avito.com/vacancies/";
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" };

export async function fetchAvito(cfg) {
  const directions = cfg.avito?.directions || ["dizayn"];
  const byId = new Map();
  for (const dir of directions) {
    const res = await fetch(`${API}?q=&action=filter&direction=${encodeURIComponent(dir)}`, {
      headers: { ...UA, "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) throw new Error(`Авито HTTP ${res.status}`);
    const { html } = await res.json();
    // карточка = <div class="vacancies-section__item" data-vacancy-geo="Москва"
    // data-vacancy-remote="Да|Нет" ...> с ссылкой и названием внутри
    for (const block of (html || "").split(/class="vacancies-section__item"[\s>]/).slice(1)) {
      const m = block.match(
        /<a href="(\/vacancies\/[a-z0-9-]+\/(\d+)\/)"[^>]*class="vacancies-section__item-name"[^>]*>([^<]+)</
      );
      if (!m) continue;
      const geo = (block.match(/data-vacancy-geo="([^"]*)"/) || [])[1] || "";
      const remote = (block.match(/data-vacancy-remote="([^"]*)"/) || [])[1] === "Да";
      byId.set(m[2], {
        source: "avito",
        id: m[2],
        title: m[3].trim(),
        company: "Авито",
        url: `https://career.avito.com${m[1]}`,
        salary: "",
        location: [geo, remote ? "удалённо" : ""].filter(Boolean).join(" · "),
        published: "",
      });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return withPubDates("avito", [...byId.values()], async (item) => {
    const res = await fetch(item.url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return (html.match(/"datePosted":\s*"([^"]+)"/) || [])[1] || "";
  });
}

export default { name: "avito", fetch: fetchAvito };
