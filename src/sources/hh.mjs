// hh.ru: публичная RSS-лента поиска — hh.ru/search/vacancy/rss.
//
// Почему не API: анонимный доступ к /vacancies закрыт (403), а токен выдают
// только по заявке с модерацией нескольких отделов, до 15 рабочих дней (их же
// FAQ) — для локального агента это неприемлемая цена входа. RSS отдаётся всем:
// без токена, без логина и даже вообще без User-Agent, то есть это штатный
// публичный фид, а не обход защиты.
//
// Цена: 20 самых свежих на запрос, `page`/`per_page` игнорируются, полного
// описания нет. Поэтому делаем запрос на направление, а не одну склейку —
// логика та же, что в linkedin.mjs. Остальные параметры поиска RSS понимает
// как сайт (проверено: area=1 и area=2 дают непересекающиеся выдачи).
const RSS = "https://hh.ru/search/vacancy/rss";
const UA = "sasaki-agent/0.1 (+https://github.com/peachcardinal/sasaki-agent)";
// hh отвечает 451 на частые запросы и отпускает через несколько секунд
const PAUSE = 5000;
const RETRIES = 2;

// Направления пульта → запрос по названию вакансии. Проверено на живой выдаче;
// «иллюстратор» hh расширяет до графического дизайна — не страшно, лишнее
// отсечёт общий фильтр по ключевым словам.
const DIRECTION_QUERY = {
  "продуктовый дизайн": "продуктовый дизайнер",
  "ux ui": "ux/ui дизайнер",
  "web дизайн": "веб-дизайнер",
  "графический дизайн": "графический дизайнер",
  "motion дизайн": "моушн-дизайнер",
  "иллюстрация": "иллюстратор",
};
const norm = (s) => String(s || "").toLowerCase().replace(/[/\-–—]+/g, " ").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Что искать: явный hh.queries → перевод выбранных направлений → первые
// ключевые слова. Каждый запрос стоит паузы, поэтому список короткий.
function queriesFor(cfg, hcfg) {
  if (hcfg.queries) return [].concat(hcfg.queries).filter(Boolean);
  const fromDirs = (cfg.directions || []).map((d) => DIRECTION_QUERY[norm(d)]).filter(Boolean);
  if (fromDirs.length) return [...new Set(fromDirs)];
  return (cfg.keywords || []).slice(0, 2);
}

export async function fetchHH(cfg) {
  const hcfg = cfg.hh || {};
  const queries = queriesFor(cfg, hcfg);
  if (!queries.length) return [];

  const byId = new Map();
  for (const [i, text] of queries.entries()) {
    if (i) await sleep(PAUSE);
    const params = new URLSearchParams({ text, search_field: "name" });
    if (hcfg.area) params.set("area", String(hcfg.area));
    if (hcfg.period) params.set("period", String(hcfg.period));
    if (hcfg.remoteOnly) params.set("schedule", "remote");
    for (const v of parseItems(await fetchFeed(`${RSS}?${params}`))) byId.set(v.id, v);
  }
  return [...byId.values()];
}

async function fetchFeed(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res.text();
    // 451 — мягкий бан за частоту, а не отказ: ждём дольше и пробуем ещё раз
    if (res.status === 451 && attempt < RETRIES) {
      await sleep(PAUSE * (attempt + 2));
      continue;
    }
    throw new Error(`hh.ru HTTP ${res.status}`);
  }
}

// Лента приходит одной строкой, поэтому режем по <item> и тянем поля регэкспами
// (stdlib, без парсера XML — как в остальных источниках).
function parseItems(xml) {
  const out = [];
  for (const block of xml.split("<item>").slice(1)) {
    const url = tag(block, "link");
    const id = (url.match(/vacancy\/(\d+)/) || [])[1];
    if (!id) continue;
    // описание — CDATA из абзацев вида «<p>Регион: Москва</p>»
    const desc = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || "";
    const salary = field(desc, "Предполагаемый уровень месячного дохода");
    out.push({
      source: "hh.ru",
      id,
      title: decode(tag(block, "title")),
      company: decode(field(desc, "Вакансия компании")),
      url,
      salary: /не указан/i.test(salary) ? "" : salary,
      location: decode(field(desc, "Регион")),
      // В ленте есть только регион, про удалёнку/гибрид она молчит. Без этого
      // флага пульт вывел бы «офис» по одному названию города — и снятая
      // галочка «офис» молча спрятала бы весь hh, включая удалённые вакансии.
      formatUnknown: true,
      published: tag(block, "pubDate"),
    });
  }
  return out;
}

const tag = (block, name) =>
  (block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1]?.trim() || "";
const field = (desc, label) =>
  (desc.match(new RegExp(`${label}:\\s*([^<]*)`)) || [])[1]?.trim() || "";

function decode(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export default { name: "hh", fetch: fetchHH };
