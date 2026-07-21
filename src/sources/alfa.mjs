// Альфа-Банк: открытый JSON API. businessLine 1011 = «Дизайн» (фильтр с их сайта).
const API = "https://job.alfabank.ru/api/vacancies";
const PAGE = 100;
const MAX_PAGES = 5;

export async function fetchAlfa(cfg) {
  const lines = cfg.alfa?.businessLines || ["1011"];
  const out = [];
  for (const line of lines) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${API}?businessLine=${line}&take=${PAGE}&skip=${page * PAGE}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`Альфа HTTP ${res.status}`);
      const json = await res.json();
      for (const v of json.items || []) {
        out.push({
          source: "alfa",
          id: String(v.id),
          title: v.name,
          company: "Альфа-Банк",
          url: `https://job.alfabank.ru/vacancies${v.slug}`,
          salary: "",
          location: fmtLocation(v),
          published: v.createdAt || "",
        });
      }
      if ((page + 1) * PAGE >= (json.total || 0)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

// Структурного поля формата у API нет: город берём из слага, формат работы
// вылавливаем из текста условий — слова, которые понимает фильтр «Формат».
const CITY = { moskva: "Москва", "sankt-peterburg": "Санкт-Петербург", ekaterinburg: "Екатеринбург", novosibirsk: "Новосибирск" };

function fmtLocation(v) {
  const slugCity = (v.slug || "").split("/")[1] || "";
  const city = CITY[slugCity] || slugCity;
  const t = [v.conditions, v.descriptionText].join(" ").toLowerCase().replaceAll("ё", "е");
  const fmt = [];
  if (/гибрид/.test(t)) fmt.push("гибрид");
  if (/удаленн|удаленк|дистанционн/.test(t)) fmt.push("удалённо");
  return [city, fmt.join("/")].filter(Boolean).join(" · ");
}

export default { name: "alfa", fetch: fetchAlfa };
