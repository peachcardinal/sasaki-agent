// designer.ru — доска вакансий для дизайнеров (раздел /u/). SSR на Bitrix,
// парсится без headless. Не prefiltered: доска общая (интерьер, графика, моушн…),
// пропускаем через обычный фильтр ключевых слов/направлений/грейда.
// Карточка: заголовок в alt картинки, компания/дата/формат — текстовыми узлами.
const BASE = "https://designer.ru/u/";
const MAX_PAGES = 3; // сортировка новее-сверху; крон добирает только новое
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const MON = { янв:0, фев:1, мар:2, апр:3, май:4, мая:4, июн:5, июл:6, авг:7, сен:8, окт:9, ноя:10, дек:11 };

// Относительная дата карточки → ISO. Без года: если вышло в будущем (декабрь,
// когда сейчас январь) — прошлый год.
function parseDate(s) {
  const now = new Date();
  if (/сегодня/i.test(s)) return now.toISOString();
  if (/вчера/i.test(s)) { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString(); }
  const m = s.match(/(\d+)\s+([а-яё]{3})/i);
  if (m && MON[m[2].toLowerCase()] != null) {
    let d = new Date(now.getFullYear(), MON[m[2].toLowerCase()], +m[1]);
    if (d - now > 86_400_000) d = new Date(now.getFullYear() - 1, MON[m[2].toLowerCase()], +m[1]);
    return d.toISOString();
  }
  return "";
}

const ENTITIES = { "&amp;":"&", "&quot;":'"', "&#039;":"'", "&apos;":"'", "&lt;":"<", "&gt;":">",
  "&nbsp;":" ", "&laquo;":"«", "&raquo;":"»", "&mdash;":"—", "&ndash;":"–" };
function decode(s) { return (s || "").replace(/&(amp|quot|#039|apos|lt|gt|nbsp|laquo|raquo|mdash|ndash);/g, (m) => ENTITIES[m]); }

// Заголовок карточки — «Компания ищет <роль>». Компанию и роль достаём из alt
// (надёжнее текстовых узлов): слева от глагола — компания, справа — роль (её
// матчит фильтр). Формат и «Freelance»-бейджи в узлах путаются, поэтому оттуда
// берём только сам формат работы по известным словам.
function splitTitle(alt) {
  const m = alt.match(/^(.*?)\s+(?:ищет|ищут|в поиске|в поисках)\s+(.+)$/i);
  if (!m) return { company: "", role: alt };
  const role = m[2].replace(/^(?:ищет|ищут)\s+/i, "").trim(); // «ищет ищет» — опечатка в данных
  return { company: m[1].trim(), role: role.charAt(0).toUpperCase() + role.slice(1) };
}

function parseCard(block) {
  const slug = (block.match(/href="\/u\/([a-z0-9-]+)\/"/) || [])[1];
  if (!slug) return null;
  const alt = decode((block.match(/alt="([^"]*)"/) || [])[1] || "").trim();
  const { company, role } = splitTitle(alt);
  const texts = [...new Set(
    block.replace(/<[^>]+>/g, " ").split(/\s{2,}|\n/).map((s) => decode(s).trim()).filter(Boolean)
  )];
  const date = texts.find((t) => /^(вчера|сегодня)$/i.test(t) || /^\d+\s+[а-яё]{3}$/i.test(t)) || "";
  // только формат работы, не длинное описание и не «Freelance»
  const format = texts.find((t) => t.length < 60 && /^(удал[её]нка|офис|гибрид)/i.test(t)) || "";
  return {
    source: "designer.ru",
    id: slug,
    title: role || alt,
    company,
    url: `${BASE}${slug}/`,
    salary: "",
    location: format,
    published: parseDate(date),
  };
}

// Грейд в заголовке карточки — тогда детальную страницу не открываем.
const GRADE_IN_TITLE = /junior|middle|senior|lead|head|intern|principal|director|джун|мидл|миддл|сеньор|синьор|старш|ведущ|\bлид\b|руковод|директор|стаж|младш/i;

// Значение поля из блока «Компания/Зарплата/Уровень дизайнера…» на детальной
// странице: после метки идёт первый непустой текстовый узел.
function fieldValue(html, label) {
  const i = html.indexOf(label);
  if (i < 0) return "";
  const seg = html.slice(i + label.length, i + label.length + 220)
    .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ");
  return decode(seg.replace(/^[\s:]+/, "")).split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
}

// Простой пул с ограничением параллелизма — чтобы не долбить сайт 180 запросами разом.
async function mapLimit(arr, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]); }
  }));
}

export async function fetchDesigner() {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE : `${BASE}?PAGEN_1=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`designer.ru HTTP ${res.status}`);
    const html = await res.text();
    const blocks = html.split(/id="bx_\d+_\d+"/).slice(1);
    let added = 0;
    for (const b of blocks) {
      const v = parseCard(b);
      if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); added++; }
    }
    if (!added) break; // пустая страница — дальше нет смысла
    await new Promise((r) => setTimeout(r, 300));
  }

  // Грейд на детальной странице — отдельным блоком «Уровень дизайнера», в ленте
  // его нет. Дёргаем деталь только там, где грейд не виден в заголовке; заодно
  // забираем зарплату (её в карточке тоже нет). Ошибки деталей не валят прогон.
  const needDetail = out.filter((v) => !GRADE_IN_TITLE.test(v.title));
  await mapLimit(needDetail, 12, async (v) => {
    try {
      const res = await fetch(v.url, { headers: { "User-Agent": UA } });
      if (!res.ok) return;
      const html = await res.text();
      const lvl = fieldValue(html, "Уровень дизайнера");
      if (lvl && !/не важно|любой|не указан/i.test(lvl)) v.level = lvl;
      const sal = fieldValue(html, "Зарплата");
      if (sal && !/не указан/i.test(sal)) v.salary = sal;
    } catch { /* деталь недоступна — остаётся то, что взяли из карточки */ }
  });

  return out;
}

export default { name: "designer.ru", fetch: fetchDesigner };
