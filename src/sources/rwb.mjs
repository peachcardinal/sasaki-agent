// RWB (Wildberries): открытый API карьерного сайта. Дизайн = direction_ids[]=11.
// Даты публикации нет НИГДЕ: ни в списке, ни в детальной /vacancies/<id>
// (проверены все поля ответа), ни на странице вакансии (SPA без дат) —
// published остаётся пустым, пайплайн подставит момент первого обнаружения.
const API = "https://career.rwb.ru/crm-api/api/v1/pub/vacancies";

export async function fetchRwb(cfg) {
  const ids = cfg.rwb?.directionIds || [11];
  const qs = ids.map((i) => `direction_ids%5B%5D=${i}`).join("&");
  const res = await fetch(`${API}?${qs}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
  });
  if (!res.ok) throw new Error(`RWB HTTP ${res.status}`);
  const json = await res.json();
  return (json.data?.items || []).map((v) => ({
    source: "rwb",
    id: String(v.id),
    title: v.name,
    company: "RWB (Wildberries)",
    url: `https://career.rwb.ru/vacancies/${v.id}`,
    salary: "",
    // грейдов у RWB нет ни в заголовке, ни в API — добавляем требуемый опыт
    // («От 3 лет»), чтобы уровень вакансии был виден хотя бы в пульте
    location: [
      v.city_title,
      (v.employment_types || []).map((e) => e.title.toLowerCase()).join("/"),
      (v.experience_type_title || "").toLowerCase(),
    ].filter(Boolean).join(" · "),
    published: "",
  }));
}

export default { name: "rwb", fetch: fetchRwb };
