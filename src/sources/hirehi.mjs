// hirehi.ru: агрегатор, открытый JSON API. Фильтры: category, level, format
// (каждый можно несколько раз), пагинация page=N + has_more. Ссылка вакансии
// /{category}/{slug}-{id}, роутинг по id (слаг делаем сами транслитом).
// Фильтрация целиком на стороне API (грейд в заголовках не пишут, по ключевым
// словам их не отобрать) → prefiltered.
const API = "https://hirehi.ru/api/search/jobs";
const MAX_PAGES = 5; // сортировка свежее-сверху; крон добирает только новое

// Параметры запроса выводим из ОБЩЕГО конфига (cfg.grades / cfg.formats), а не
// из отдельной секции hirehi: раньше та жила своей жизнью и разъезжалась с
// фильтрами пульта — запрашивали level=lead&head, а structuralOk требовал
// senior → вся выдача hirehi выбрасывалась, в ленту не попадало ничего.
const GRADE_TO_LEVEL = {
  intern: "intern", junior: "junior", middle: "middle",
  senior: "senior", staff: "senior",
  lead: "lead", principal: "head", head: "head", director: "head",
};
const FORMAT_TO_HIREHI = {
  remote: ["удалённо", "удалённо по РФ"],
  hybrid: ["гибрид"],
  office: ["офис"],
};

const uniq = (a) => [...new Set(a.filter(Boolean))];

export function hirehiQuery(cfg) {
  return {
    levels: uniq((cfg.grades || []).map((g) => GRADE_TO_LEVEL[g])),
    formats: uniq((cfg.formats || []).flatMap((f) => FORMAT_TO_HIREHI[f] || [])),
  };
}

export async function fetchHirehi(cfg) {
  const categories = cfg.hirehi?.categories || ["design"];
  const { levels, formats } = hirehiQuery(cfg);
  const out = [];
  for (const cat of categories) {
    const levelQs = levels.map((l) => `&level=${encodeURIComponent(l)}`).join("")
      + formats.map((f) => `&format=${encodeURIComponent(f)}`).join("");
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`${API}?category=${encodeURIComponent(cat)}${levelQs}&page=${page}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
      });
      if (!res.ok) throw new Error(`hirehi HTTP ${res.status}`);
      const json = await res.json();
      for (const v of json.jobs || []) {
        out.push({
          source: "hirehi",
          id: String(v.id),
          title: v.title,
          company: v.company || "",
          url: `https://hirehi.ru/${cat}/${translit(v.title)}-${v.id}`,
          salary: /не указана/i.test(v.salary_display || "") ? "" : v.salary_display || "",
          location: [v.format, v.level].filter(Boolean).join(" · "),
          level: v.level || "",
          format: v.format || "",
          published: v.created_at || "",
          prefiltered: true,
        });
      }
      if (!json.has_more || !(json.jobs || []).length) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return out;
}

const TR = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"i",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };

function translit(s) {
  return (s || "")
    .toLowerCase()
    .split("")
    .map((c) => TR[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "job";
}

export default { name: "hirehi", fetch: fetchHirehi };
