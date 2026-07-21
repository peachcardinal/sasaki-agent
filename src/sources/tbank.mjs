// Т-Банк: внутренний API карьерного сайта (найден через перехват в браузере).
// POST getVacancies; pagination — объект по источникам ("it", "job", ...),
// фильтр профессии — ключ вида tcareer_<category>_profession.
const API = "https://www.tbank.ru/pfpjobs/papi/getVacancies";
const PAGE = 50;
const MAX_PAGES = 6;
const WORK_MODES = new Set(["Удаленный", "Офис", "Гибрид"]);
// Грейды приходят тегами ("Middle", "Senior", ...) — заголовки их не содержат;
// прокидываем в item.level, чтобы фильтр мог матчить ключевые слова по грейду.
const GRADE_TAGS = new Set(["junior", "middle", "senior", "lead", "head"]);

export async function fetchTbank(cfg) {
  const category = cfg.tbank?.category || "it";
  const professions = cfg.tbank?.professions || ["design"];
  const out = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1",
      },
      body: JSON.stringify({
        pagination: { [category]: { offset } },
        limit: PAGE,
        filters: { category, [`tcareer_${category}_profession`]: professions },
      }),
    });
    if (!res.ok) throw new Error(`Т-Банк HTTP ${res.status}`);
    const json = await res.json();
    if (json.resultCode !== "OK") throw new Error(`Т-Банк: ${json.errorMessage || json.resultCode}`);
    for (const v of json.payload?.vacancies || []) {
      const modes = (v.tags || []).filter((t) => WORK_MODES.has(t)).join("/");
      const grades = (v.tags || []).filter((t) => GRADE_TAGS.has(t.toLowerCase()));
      out.push({
        source: "tbank",
        id: v.urlSlug || v.seoSlug,
        title: v.title,
        company: "Т-Банк",
        // роут вакансии требует город в пути (см. sitemap); вакансии доступны
        // под любым городом, cities в API пустые — берём Москву как контекст
        url: `https://www.tbank.ru/career/${category}/vacancy/moskva/${v.seoSlug}/${v.urlSlug}/`,
        salary: v.salary || "",
        location: [v.subtitle, modes.toLowerCase(), grades.join("/").toLowerCase()]
          .filter(Boolean).join(" · "),
        level: grades.join("/"),
        published: "",
      });
    }
    const next = json.payload?.nextPagination?.[category];
    if (!next || next.isFinished || !json.payload?.vacancies?.length) break;
    offset = next.offset;
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

export default { name: "tbank", fetch: fetchTbank };
