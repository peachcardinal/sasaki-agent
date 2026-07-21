// Телеграм-каналы через ПУБЛИЧНУЮ веб-ленту t.me/s/<канал> — без авторизации,
// без API-ключа, без Telethon. Работает для любых публичных каналов (@username).
// Курсоры по последнему msg_id в data/tg-cursors.json. Приватные каналы и полная
// история — через опциональный источник telethon (examples/sources/telegram-telethon.mjs).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../lib/env.mjs";
import { matchesKeywords, inferGrades, roleKeywords } from "../lib/filter.mjs";

const cursorsPath = join(projectRoot, "data", "tg-cursors.json");

export async function fetchTelegramChannels(cfg) {
  const all = cfg.telegram?.channels || [];
  if (all.length === 0) {
    throw new Error("каналы не заданы (config.json → telegram.channels) — источник пропущен");
  }
  // выключенные в пульте каналы (config.json → telegram.disabled)
  const off = new Set((cfg.telegram?.disabled || []).map(channelName));
  const channels = all.filter((c) => !off.has(channelName(c)));
  if (channels.length === 0) return [];
  const cursors = loadCursors();
  const kws = roleKeywords(cfg); // направления + ключевые слова, раскрытые (UX/UI → ux|ui)
  const out = [];
  const errors = [];
  // Докуда листать историю канала (по дате поста). Курсор обычно останавливает
  // раньше; окно защищает первый скан и прогоны после долгого простоя, чтобы не
  // тянуть весь канал. 0 = без ограничения по дате.
  const lookbackDays = Number(cfg.telegram?.backfillDays ?? cfg.retentionDays ?? 30);
  const cutoffMs = lookbackDays > 0 ? Date.now() - lookbackDays * 86_400_000 : 0;

  for (const raw of channels) {
    const name = channelName(raw);
    try {
      const posts = await fetchChannel(name, cursors[name] || 0, cutoffMs);
      for (const p of posts) {
        cursors[name] = Math.max(cursors[name] || 0, p.msgId);
        if (!matchesKeywords(p.text, kws)) continue;
        const company = companyFrom(p.text);
        out.push({
          source: "telegram",
          id: `${name}:${p.msgId}`,
          title: stripCompanyFromTitle(jobTitle(p.text), company),
          company,
          url: `https://t.me/${name}/${p.msgId}`,     // сам пост (контекст)
          applyUrl: applyLink(p.urls),                 // прямая ссылка-отклик из поста
          salary: "",
          location: locationFrom(p.text),              // формат работы (+город) из текста поста
          level: levelFrom(p.text),                    // явный «Уровень: …», если есть
          published: p.date || "",
          prefiltered: true,
        });
      }
    } catch (e) {
      errors.push(name);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (errors.length) console.error(`[telegram] недоступны (публичные ли?): ${errors.join(", ")}`);
  saveCursors(cursors);
  return out;
}

// --- парсинг t.me/s/<канал> --------------------------------------------------

// t.me/s/<канал> отдаёт ~20 последних постов; ?before=<msgId> — 20 более старых.
// Листаем назад до курсора (уже собранное) или до окна по дате, чтобы между
// редкими прогонами посты не терялись за 20-постовым окном. MAX_PAGES — предел
// на первый скан (до ~160 постов на канал).
const MAX_PAGES = 8;

async function fetchChannel(name, sinceId, cutoffMs) {
  const posts = [];
  let before = 0; // 0 — последняя (самая свежая) страница
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://t.me/s/${name}${before ? `?before=${before}` : ""}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // каждый пост — блок с data-post="<канал>/<id>"; режем по этому якорю
    const chunks = html.split('data-post="').slice(1);
    if (!chunks.length) break;
    let minId = Infinity, caughtUp = false, oldestTs = Infinity;
    for (const chunk of chunks) {
      const msgId = parseInt((chunk.match(/^[^/]+\/(\d+)"/) || [])[1], 10);
      if (!msgId) continue;
      minId = Math.min(minId, msgId);
      if (msgId <= sinceId) { caughtUp = true; continue; } // дошли до собранного в прошлый раз
      const textBlock = (chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
      const date = (chunk.match(/datetime="([^"]+)"/) || [])[1] || "";
      const ts = Date.parse(date) || 0;
      if (ts) oldestTs = Math.min(oldestTs, ts);
      if (cutoffMs && ts && ts < cutoffMs) continue; // старее окна — пропускаем
      const urls = [...textBlock.matchAll(/href="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
      posts.push({ msgId, text: htmlToText(textBlock), urls, date });
    }
    if (caughtUp) break;                                  // догнали курсор
    if (cutoffMs && oldestTs !== Infinity && oldestTs < cutoffMs) break; // ушли за окно
    if (minId === Infinity || minId <= 1) break;          // достигли начала канала
    before = minId;
    await new Promise((r) => setTimeout(r, 250));         // вежливая пауза между страницами
  }
  return posts;
}

function htmlToText(html) {
  // NFKC разворачивает «дизайнерские» юникод-шрифты (математический жирный/
  // курсив и пр.: 𝐃𝐞𝐬𝐢𝐠𝐧𝐞𝐫 → Designer) в обычные буквы — иначе парсер не
  // распознаёт роль в заголовке и берёт строку описания.
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  ).normalize("NFKC").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(s) {
  let out = s || "";
  // телеграм местами кодирует & многократно (&amp;amp;) — раскручиваем до конца
  while (out.includes("&amp;")) out = out.replaceAll("&amp;", "&");
  return out
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))       // &#33; → !
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Компания не должна дублироваться в заголовке: «Дизайнер в X» / «Дизайнер X»
// при известной компании X → «Дизайнер» (компания показывается отдельно).
export function stripCompanyFromTitle(title, company) {
  if (!company) return title;
  const esc = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cleaned = title
    .replace(new RegExp(`\\s+(?:в|у|от|для)\\s+«?${esc}»?\\s*$`, "i"), "")
    // «Роль …, Компания» — вместе с запятой, иначе остаётся висячий хвост
    .replace(new RegExp(`\\s*,\\s*«?${esc}»?\\s*$`, "i"), "")
    .replace(new RegExp(`\\s+«?${esc}»?\\s*$`, "i"), "")
    .trim();
  return cleaned.length >= 5 ? cleaned : title; // не оставляем огрызок
}

// Явный грейд поста. Сигналы по убыванию надёжности: строка «Уровень: …» /
// «Грейд middle+» (двоеточие необязательно), хештеги-грейды (#senior — так
// размечает geekjobs), грейд вплотную к роли в теле («ищем старшего
// продуктового дизайнера», «UI/UX Designer Middle+»). Берём, только если
// в найденном распознаётся грейд — иначе пустая строка (грейд из заголовка
// пульт выводит сам).
export function levelFrom(text) {
  const t = text || "";
  const m = t.match(/(?:уровень|грейд|level|grade)\s*[:—–-]?\s*([^\n]{2,40})/i);
  if (m && inferGrades(m[1]).length) return m[1].trim();
  const tags = [...t.matchAll(/#(intern|trainee|junior|middle|senior|lead|staff|head|джун\w*|мидл\w*|миддл\w*|синьор\w*|сеньор\w*|тимлид\w*|стаж[её]р\w*)(?![\w/])/gi)]
    .map((x) => canonGrade(x[1]));
  if (tags.length) return [...new Set(tags)].join(" ");
  // грейд вплотную к роли; в дайджестах (несколько видимых ссылок = список
  // РАЗНЫХ вакансий) не применяем — грейд взялся бы из чужой строки
  if ((t.match(/https?:\/\//g) || []).length < 3) return gradeNearRole(t);
  return "";
}

// Слова-грейды (включая падежи) и роль-цель: грейд считается грейдом вакансии,
// только когда стоит вплотную к дизайнерской роли — «старший разработчик»
// в соседнем абзаце вакансию дизайнера не переоценит.
const GRADE_T = "стаж[её]р\\w*|intern|trainee|джун\\w*|junior|младш\\w*|мидл\\w*|миддл\\w*|middle|старш\\w*|сеньор\\w*|синьор\\w*|senior|ведущ\\w*|лид(?:[ае]|ом)?(?![а-яё])|lead|тимлид\\w*|staff|стафф\\w*|главн\\w*|principal";
const ROLE_T = "(?:(?:продуктов\\w+|графическ\\w+|коммуникационн\\w+|визуальн\\w+|веб|web|моушн\\w*|motion|ux|ui|ux\\/ui|ui\\/ux|product|graphic|digital|контент)[\\s/-]+){0,2}(?:дизайнер\\w*|designer\\w*)";
const GRADE_ROLE_RE = new RegExp(`(?:^|[^а-яёa-z])((?:${GRADE_T})(?:\\s*[+/,]\\s*(?:${GRADE_T}))*\\+?)[\\s/-]+${ROLE_T}`, "i");
const ROLE_GRADE_RE = new RegExp(`(?:дизайнер\\w*|designer)[\\s,]+(?:уровня\\s+)?((?:${GRADE_T})\\+?(?:\\s*(?:[+/,]|или)\\s*(?:${GRADE_T})\\+?)*)`, "i");

function canonGrade(w) {
  for (const [re, g] of [
    [/^(стаж|intern|trainee)/i, "intern"], [/^(джун|junior|младш)/i, "junior"],
    [/^(мидл|миддл|middle)/i, "middle"], [/^(старш|сеньор|синьор|senior)/i, "senior"],
    [/^(ведущ|лид|lead|тимлид)/i, "lead"], [/^(staff|стафф)/i, "staff"],
    [/^(главн|principal|chief)/i, "principal"],
  ]) if (re.test(w)) return g;
  return "";
}

function gradeNearRole(text) {
  const m = text.match(GRADE_ROLE_RE) || text.match(ROLE_GRADE_RE);
  if (!m) return "";
  const grades = m[1].split(/[^a-zа-яё+]+/i).map(canonGrade).filter(Boolean);
  // «middle+» значит «middle и выше» — добираем senior, чтобы фильтр
  // по senior такую вакансию не срезал
  if (/\+/.test(m[1]) && grades.includes("middle") && !grades.includes("senior")) grades.push("senior");
  return [...new Set(grades)].join(" ");
}

// Формат работы из свободного текста поста — в location, в словах, которые
// понимает фильтр «Формат» в пульте (удалённо/гибрид/офис). Не нашли — "".
function workFormatFrom(text) {
  const t = (text || "").toLowerCase().replaceAll("ё", "е");
  const out = [];
  if (/удаленн|удаленк|remote|дистанционн/.test(t)) out.push("удалённо");
  if (/гибрид|hybrid/.test(t)) out.push("гибрид");
  if (/офис|office|on-?site/.test(t)) out.push("офис");
  return out.join("/");
}

// Город из текста поста — по словарю частых городов найма, слово к слову
// (кириллический \b не работает, поэтому матчим каждое слово с начала;
// падежи покрыты «хвостовой» частью регэкспа). Для гибрида/офиса город —
// часть смысла вакансии; для чистой удалёнки он не нужен.
const CITY_WORDS = [
  [/^москв/, "Москва"], [/^(санкт-)?петербург|^питер(?!\w*ing)|^спб$/, "Санкт-Петербург"],
  [/^новосибирск/, "Новосибирск"], [/^екатеринбург/, "Екатеринбург"],
  [/^казан[ьи]/, "Казань"], [/^новгород/, "Нижний Новгород"],
  [/^краснодар/, "Краснодар"], [/^ростов/, "Ростов-на-Дону"],
  [/^самар[аеы]/, "Самара"], [/^уф[аеуы]$/, "Уфа"], [/^перм[ьи]/, "Пермь"],
  [/^воронеж/, "Воронеж"], [/^челябинск/, "Челябинск"], [/^красноярск/, "Красноярск"],
  [/^омск/, "Омск"], [/^томск/, "Томск"], [/^тюмен/, "Тюмень"], [/^иркутск/, "Иркутск"],
  [/^владивосток/, "Владивосток"], [/^калининград/, "Калининград"], [/^сочи$/, "Сочи"],
  [/^минск/, "Минск"], [/^алматы$|^алма-ата/, "Алматы"], [/^астан[аеу]/, "Астана"],
  [/^ташкент/, "Ташкент"], [/^ереван/, "Ереван"], [/^тбилиси$/, "Тбилиси"],
  [/^белград/, "Белград"], [/^лимассол/, "Лимассол"], [/^дуба[йея]/, "Дубай"],
];

function cityFrom(text) {
  const words = (text || "").toLowerCase().replaceAll("ё", "е").split(/[^a-zа-я-]+/);
  for (const w of words) {
    for (const [re, name] of CITY_WORDS) if (re.test(w)) return name;
  }
  return "";
}

// location для пульта: формат работы, а для гибрида/офиса — ещё и город.
function locationFrom(text) {
  const fmt = workFormatFrom(text);
  const city = /гибрид|офис/.test(fmt) ? cityFrom(text) : "";
  return city ? `${fmt} · ${city}` : fmt;
}

// --- ссылка-отклик и утилиты -------------------------------------------------

const APPLY_HOSTS = /linkedin\.com|hh\.ru|career|jobs?|getmatch|habr|forms?|notion|greenhouse|lever|workable|boards/i;

function applyLink(urls = []) {
  const external = urls.filter((u) => /^https?:\/\//.test(u) && !/t\.me|telegram\.me/.test(u));
  return external.find((u) => APPLY_HOSTS.test(u)) || external[0] || "";
}

// @name / t.me/name / https://t.me/s/name → «name»
function channelName(ref) {
  return String(ref).trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^t\.me\/(s\/)?/, "")
    .replace(/\/.*$/, "");
}

// Служебные строки, которые не являются названием вакансии.
// (без \b — в JS он не работает с кириллицей).
const NOISE_LINE = /^(ваканси|#\S+$|ищ[уе]м?[\s_]|вниман|розыск|реклам|партн[её]р|подпис|дайджест|подборк|итоги)/i;
// Строки-метаданные: атрибуты вакансии, а не её название («Условия работы: …»).
const META_LINE = /^(условия|локац|формат|зарплат|з\/?п[\s:]|оклад|график|требован|задач|обязанност|опыт|контакт|о компании|о нас|о проекте|что делать|что предстоит|чем предстоит|кого ищем|мы предлагаем|предлагаем|бонус|плюшк|откликн|подробн|ссылк|резюме|стек|инструмент|занятост|оформлен|тестов|этап|важно|уровень|грейд)/i;

// Роль из винительного падежа в именительный: «коммуникационного дизайнера» →
// «коммуникационный дизайнер». Правила грубые, но на фразах-ролях работают.
const ROLE_NOUNS = "дизайнер|иллюстратор|аниматор|директор|менеджер|редактор|архитектор|визуализатор|моделлер|маркетолог|копирайтер|специалист|художник|разработчик|проектировщик|ретуш[её]р|исследовател|лид";
function nominativeRole(s) {
  // конвертируем только «голову» фразы — до первого предлога-хвоста:
  // «… для телевизионного проекта», «… в команду X» должны остаться как есть
  const m = s.match(/\s(?:в|во|для|на|с|со|к|из|по|у)\s/);
  const cut = m ? m.index : s.length;
  const head = s.slice(0, cut)
    .replace(/([а-яё]+?)его(?=\s|$)/gi, "$1ий")            // старшего → старший
    .replace(/([а-яё]+?[гкхжчшщ])(?:ого|их)(?=\s|$)/gi, "$1ий") // графического/их → графический
    .replace(/([а-яё]+?)(?:ого|ых)(?=\s|$)/gi, "$1ый")     // продуктового/ых → продуктовый
    .replace(new RegExp(`(${ROLE_NOUNS})(ами|ов|ев|а|я|ю|у|ы|и)(?=\\s|$|[,./(-])`, "gi"), "$1")
    .replace(/руководител(?=\s|$|[,./(-])/gi, "руководитель")
    .replace(/исследовател(?=\s|$|[,./(-])/gi, "исследователь");
  return head + s.slice(cut);
}

// Заголовок вакансии из поста. Приоритет: (1) роль из конструкции «X ищет Y» /
// «Ищем Y» — без компании и в именительном падеже; (2) первая строка с
// упоминанием роли; (3) первая содержательная строка. Хештеги, служебные
// строки и метаданные пропускаются. Для дайджестов (1 пост = список) это
// лишь ориентир по первой вакансии.
export function jobTitle(text) {
  // снять обёртку "Канал pinned «...»"
  const unpinned = text.replace(/^.*?\bpinned\b\s*«?/s, "").trim() || text;
  const lines = unpinned.split("\n")
    .map((raw) => raw.replace(/^[^\p{L}\d#]+/u, "").trim()) // убрать ведущие эмодзи/буллеты
    .filter((l) => l.length >= 3);
  const trim90 = (s) => (s.length > 90 ? s.slice(0, 87) + "…" : s);

  // 1) «X ищет Y» / «Ищем Y» / «Требуется Y» → роль Y
  for (const line of lines.slice(0, 8)) {
    if (META_LINE.test(line)) continue;
    let m = line.match(/^«?(.{2,45}?)»?\s+(?:ищет|ищут|в\s+поисках?|в\s+поиске|набирает|приглашает)\s+(.{3,90})$/i);
    let role = m?.[2];
    if (!role) {
      // «Ищем Y» в начале строки или после вводной с двоеточием («…: ищем Y»)
      m = line.match(/^(?:.{0,60}?:\s*)?(?:мы\s+|очень\s+|срочно\s+)?(?:ищем|ищу|требуется|разыскивается|нужен|нужна)\s+(.{3,90})$/i);
      role = m?.[1];
    }
    if (!role) continue;
    role = role
      .replace(/[.!?…].*$/, "")                             // хвост предложения после роли
      .replace(/^(?:себе\s+)?(?:в\s+(?:команду|штат)|к\s+нам(?:\s+в\s+команду)?)\s+/i, "")
      .replace(/^(?:двух|тр[её]х|четыр[её]х|пяти|нескольких|пару|одного)\s+/i, "")
      .trim();
    if (role.length >= 3 && !/^\d/.test(role) && ROLE_WORD.test(role)) {
      const t = nominativeRole(role);
      return trim90(t[0].toUpperCase() + t.slice(1));
    }
  }
  // 2) первая строка, где упомянута роль
  for (const line of lines) {
    if (NOISE_LINE.test(line) || META_LINE.test(line)) continue;
    if (ROLE_WORD.test(line)) return trim90(line);
  }
  // 3) первая содержательная строка
  for (const line of lines) {
    if (NOISE_LINE.test(line) || META_LINE.test(line)) continue;
    return trim90(line);
  }
  return trim90(lines[0] || "");
}

// --- компания из текста поста ------------------------------------------------
// Свободный текст каналов разнится, поэтому паттерны идут по убыванию
// надёжности: явные конструкции в теле («Компания X», «X ищет», «О компании»),
// затем заголовок («Роль в X», латинский/заглавный хвост). Не нашли — пустая
// строка, в пульте останется только @канал.

const SEEK_VERB = "(?:ищет|ищут|в\\s+поисках?|в\\s+поиске|набирает|приглашает)";
// слова, которые не бывают названием компании (проверяются по каждому слову)
const NOT_COMPANY = /^(мы|нас|наш[аеи]?|вас|ваш[аеи]?|для|что|как|это|если|сейчас|снова|новый|молодой|котор\S*|друзья|ребята?|привет|команда|проект|стартап|компани\S*|вакансия|работ\S*|формат\S*|сайт|топ|кого|задач\S*|целевая|аудитори\S*|портфолио|промокод\S*|запишись|миллион\S*|пользовател\S*|локаци\S*|международн\S*|удал[её]н\S*|remote|hybrid|office|onsite|офис\S*|гибрид\S*|москва|спб|питер|продукт\S*|blender|figma|photoshop|cinema|unity|unreal|tilda|январ\S*|феврал\S*|март\S*|апрел\S*|ма[йя]|июн\S*|июл\S*|август\S*|сентябр\S*|октябр\S*|ноябр\S*|декабр\S*)$/i;
// латиница — по границам слова, чтобы не задевать Emotions/Headspace и т.п.;
// для кириллицы \b не работает — там подстроки
const ROLE_WORD = /\b(designer|design|lead|senior|middle|junior|head|director|manager|graphic|product|motion|animator|ux|ui)\b|дизайн|директор|арт-|руководител|менеджер|специалист|художник|иллюстратор|аниматор|моушн/i;

function cleanCompany(raw) {
  const s = (raw || "")
    .replace(/[«»"“”']/g, "")
    .replace(/^\d+[).]\s*/, "")                    // нумерация в дайджестах: «1) X»
    .replace(/^[\s,.;:!?—–-]+|[\s,.;:!?—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2 || s.length > 40) return "";
  if (/[!?:;/|\n]/.test(s)) return "";
  if (ROLE_WORD.test(s)) return "";
  const words = s.split(/\s+/);
  if (words.length > 5) return "";
  if (words.some((w) => NOT_COMPANY.test(w))) return "";
  if (!/[\p{L}\d]/u.test(s)) return "";
  return s;
}

export function companyFrom(text) {
  const lines = text.split("\n").map((l) => l.replace(/^[^\p{L}\d«"]+/u, "").trim()).filter(Boolean);
  const title = jobTitle(text);
  const candidates = [];

  // «X ищет …» — первая такая строка поста, из неё же jobTitle берёт роль:
  // компания и заголовок остаются согласованными (важно в дайджестах)
  for (const l of lines.slice(0, 8)) {
    if (META_LINE.test(l)) continue;
    const m = l.match(new RegExp(`^«?(.{2,45}?)»?\\s+${SEEK_VERB}\\s`, "i"));
    if (m && !ROLE_WORD.test(m[1])) { candidates.push(m[1]); break; }
  }

  for (const l of lines) {
    // «Компания «X» …» / «Агентство X ищет …»
    let m = l.match(/(?:компани[яию]|агентств[оа]|студи[яию]|бренд[ае]?|онлайн-школ[ау]|школ[ау])\s+«([^»]{2,40})»/i);
    if (m) candidates.push(m[1]);
    m = l.match(new RegExp(`(?:[Кк]омпания|[Аа]гентство|[Сс]тудия|[Бб]ренд)\\s+([A-ZА-ЯЁ0-9«"]\\S*(?:\\s+\\S+){0,3}?)\\s+${SEEK_VERB}`, ""));
    if (m) candidates.push(m[1]);
    // «… «X» в поисках …» — имя в кавычках прямо перед глаголом поиска
    // (в именительном падеже, в отличие от хвоста заголовка «в „Гориллу“»)
    m = l.match(new RegExp(`«([^»]{2,40})»\\s+${SEEK_VERB}`, "i"));
    if (m && !ROLE_WORD.test(m[1])) candidates.push(m[1]);
    // «В X открыта позиция/вакансия/роль …»
    m = l.match(/(?:^|[.!?]\s+)в\s+«?([A-ZА-ЯЁ0-9][^\s«»,]{1,29})»?\s+открыт[аы]?\s+(?:позици|ваканси|роль)/iu);
    if (m && !ROLE_WORD.test(m[1])) candidates.push(m[1]);
  }
  // «X ищет …» в начале строки
  for (const l of lines) {
    const m = l.match(new RegExp(`^«?(.{2,45}?)»?\\s+${SEEK_VERB}[\\s:]`, "i"));
    if (m && !ROLE_WORD.test(m[1])) candidates.push(m[1]);
  }
  // «для проекта X» / «в команду X» (латиница — иначе слишком шумно)
  for (const l of lines) {
    const m = l.match(/(?:проект[ау]?|команд[ыу])\s+«?([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z0-9][A-Za-z0-9&.-]*)*)/);
    if (m) candidates.push(m[1]);
  }
  // секция «О компании» — ведущие слова с заглавной следующей строки
  const about = lines.findIndex((l) => /^о компании/i.test(l));
  if (about >= 0 && lines[about + 1]) {
    const cap = [];
    for (const t of lines[about + 1].split(/\s+/)) {
      if (/^[«"]?[A-ZА-ЯЁ0-9]/.test(t)) cap.push(t); else break;
    }
    if (cap.length) candidates.push(cap.join(" "));
  }
  // заголовок: «Роль …«X»» — кавычки в конце заголовка надёжнее прочего
  let m = title.match(/«([^»]{2,40})»\s*$/);
  if (m) candidates.push(m[1]);
  // «X — описание …» в первых строках поста (и англ. «X is a …»)
  for (const l of lines.slice(0, 6)) {
    const dm = l.match(/^«?([A-ZА-ЯЁ0-9][^—]{1,44}?)»?\s+—\s+[а-яёa-z]/u);
    if (dm && !ROLE_WORD.test(dm[1])) candidates.push(dm[1]);
    const em = l.match(/^([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,3})\s+is\s+(?:a|an|the)\s/);
    if (em && !ROLE_WORD.test(em[1])) candidates.push(em[1]);
  }
  // компания отдельной короткой строкой сразу после заголовка-роли:
  // «Старший дизайнер\nAIRI\nЧто делать: …»
  const roleIdx = lines.findIndex((l) => ROLE_WORD.test(l));
  if (roleIdx >= 0 && roleIdx <= 1 && lines[roleIdx + 1]) {
    const cand = lines[roleIdx + 1];
    if (cand.length <= 30 && cand.split(/\s+/).length <= 3
      && !/[()₽$€:;!?]|\d/.test(cand) && /^[A-ZА-ЯЁ«"]/.test(cand)) {
      candidates.push(cand);
    }
  }
  // заголовок: «Роль …, КОМПАНИЯ» — компания последним сегментом после запятой
  // («Продуктовый дизайнер (B2C) в Управление продуктов…, ВТБ»). Правило «Роль
  // в X» ниже сюда не достаёт: оно запрещает запятые внутри имени. Отсекаем
  // города, форматы и грейды — иначе компанией станет «Москва» или «удалённо».
  m = title.match(/,\s*«?([^,«»]{2,30})»?\s*$/u);
  if (m) {
    const tail = m[1].trim();
    if (/^[A-ZА-ЯЁ0-9]/.test(tail) && !ROLE_WORD.test(tail)
      && !cityFrom(tail) && !workFormatFrom(tail) && !inferGrades(tail).length) {
      candidates.push(tail);
    }
  }
  // заголовок: «Роль в X»
  m = title.match(/\s(?:в|для)\s+«?([A-ZА-ЯЁ][^,;:]{1,40}?)»?$/u);
  if (m) candidates.push(m[1]);
  m = title.replace(/\s*\([^)]*\)\s*$/, "").match(/[а-яё]\s+((?:[A-ZА-ЯЁ0-9][\p{L}\p{N}&.-]*)(?:\s+[A-ZА-ЯЁ0-9][\p{L}\p{N}&.-]*)*)$/u);
  if (m && !ROLE_WORD.test(m[1])) candidates.push(m[1]);

  for (const c of candidates) {
    const ok = cleanCompany(c);
    if (ok) return ok;
  }
  return "";
}

function loadCursors() {
  try {
    return JSON.parse(readFileSync(cursorsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveCursors(cursors) {
  mkdirSync(join(projectRoot, "data"), { recursive: true });
  writeFileSync(cursorsPath, JSON.stringify(cursors, null, 1));
}

export default { name: "telegram", fetch: fetchTelegramChannels };
