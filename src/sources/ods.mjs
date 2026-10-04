// ODS.ai Jobs: публичный API, который использует страница /jobs.
// Список содержит опубликованные вакансии; листаем свежие записи до конца.
const API = "https://api.ods.ai/api/tools/vacancy/list/";
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const CURRENCY = { RUB: "₽", USD: "$", EUR: "€", KZT: "₸" };
const PERIOD = { Month: "/мес.", Year: "/год", Hour: "/час" };

export async function fetchOds(cfg) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1",
        Referer: "https://ods.ai/jobs",
      },
      body: JSON.stringify({
        status: ["Published"],
        sort: "-publication_dt",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    });
    if (!res.ok) throw new Error(`ODS.ai HTTP ${res.status}`);
    const data = await res.json();
    const vacancies = data.vacancies || [];
    for (const v of vacancies) {
      const cities = (v.cities || []).map((city) => typeof city === "string" ? city : city.name).filter(Boolean);
      out.push({
        source: "ods",
        id: String(v.id),
        title: v.title || "",
        company: "",
        url: `https://ods.ai/jobs/${v.id}`,
        salary: salaryOf(v),
        location: [formatOf(v.work_type), ...cities, v.type_of_employment].filter(Boolean).join(" · "),
        published: v.publication_dt || "",
      });
    }
    if (vacancies.length < PAGE_SIZE) break;
    if (page + 1 < MAX_PAGES) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return out;
}

function salaryOf(v) {
  if (!v.salary_from && !v.salary_to) return "";
  const currency = CURRENCY[v.salary_currency] || v.salary_currency || "";
  const amount = (n) => `${Number(n).toLocaleString("ru-RU")} ${currency}`.trim();
  const range = v.salary_from && v.salary_to
    ? `${amount(v.salary_from)}–${amount(v.salary_to)}`
    : v.salary_from ? `от ${amount(v.salary_from)}` : `до ${amount(v.salary_to)}`;
  return `${range}${PERIOD[v.salary_payment_period] || ""}`;
}

function formatOf(value) {
  if (!value) return "";
  return String(value).replace(/remote/ig, "удалённо").replace(/office/ig, "офис");
}

export default { name: "ods", fetch: fetchOds };
