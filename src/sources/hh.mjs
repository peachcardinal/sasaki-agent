// hh.ru: официальный API. Анонимные запросы hh закрыл, нужен токен приложения
// с dev.hh.ru — см. README, раздел «hh.ru». Без HH_TOKEN источник пропускается.
export async function fetchHH(cfg) {
  const token = process.env.HH_TOKEN;
  if (!token) throw new Error("HH_TOKEN не задан в .env — источник пропущен (как получить: README → hh.ru)");

  const text = cfg.keywords.map((k) => `"${k}"`).join(" OR ");
  const params = new URLSearchParams({
    text,
    search_field: "name",
    per_page: "100",
    order_by: "publication_time",
  });
  const res = await fetch(`https://api.hh.ru/vacancies?${params}`, {
    headers: {
      "User-Agent": "sasaki-agent/0.1",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`hh.ru HTTP ${res.status}`);
  const json = await res.json();

  return (json.items || []).map((v) => ({
    source: "hh.ru",
    id: String(v.id),
    title: v.name,
    company: v.employer?.name || "",
    url: v.alternate_url,
    salary: fmtSalary(v.salary),
    location: v.area?.name || "",
    published: v.published_at,
  }));
}

export default { name: "hh", fetch: fetchHH };

function fmtSalary(s) {
  if (!s) return "";
  const cur = { RUR: "₽", USD: "$", EUR: "€", KZT: "₸" }[s.currency] || s.currency || "";
  const k = (n) => Math.round(n / 1000) + "k";
  if (s.from && s.to) return `${k(s.from)}–${k(s.to)} ${cur}`;
  if (s.from) return `от ${k(s.from)} ${cur}`;
  if (s.to) return `до ${k(s.to)} ${cur}`;
  return "";
}
