// Нормализация: нижний регистр, ё→е, дефисы/слэши → пробел.
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[-–—/|,()«»"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Эквиваленты грейдов и близких инженерных ролей.
const SYNONYM_PAIRS = [
  ["исследователь", "researcher"], ["учёный", "scientist"],
  // грейды и руководство — вся лестница
  ["стажер", "intern"], ["стажер", "trainee"],
  ["младший", "junior"], ["джуниор", "junior"],
  ["мидл", "middle"],
  ["старший", "senior"], ["сеньор", "senior"],
  ["ведущий", "lead"], ["лид", "lead"],
  ["стафф", "staff"], ["главный", "principal"], ["главный", "chief"],
  ["эксперт", "expert"],
  ["руководитель", "head"], ["глава", "head"], ["директор", "director"],
  ["менеджер", "manager"],
  ["машинное обучение", "machine learning"],
  // Эти пары нужны, чтобы стоп-слова одинаково действовали на русском и английском.
  ["аналитик", "analyst"], ["разработчик", "developer"],
  ["инженер", "engineer"], ["тестировщик", "qa"],
  ["маркетолог", "marketer"], ["рекрутер", "recruiter"],
];

const SYNONYMS = new Map();
for (const [a, b] of SYNONYM_PAIRS) {
  SYNONYMS.set(a, (SYNONYMS.get(a) || new Set()).add(b));
  SYNONYMS.set(b, (SYNONYMS.get(b) || new Set()).add(a));
}

// Слово ключевой фразы + его эквиваленты. Словарь ищется по префиксу, чтобы
// русские окончания и формы слов не мешали совпадению.
function variants(word) {
  const out = new Set([word]);
  for (const [key, set] of SYNONYMS) {
    if (word.startsWith(key) || key.startsWith(word)) {
      for (const v of set) out.add(v);
    }
  }
  for (const v of [...out]) {
    for (const v2 of SYNONYMS.get(v) || []) out.add(v2);
  }
  return [...out];
}

// Кириллица сравнивается по префиксу (падежи), латиница — точно или с плюралом,
// но не по префиксу: иначе "ml" матчил бы лишние слова.
function wordHits(w, v) {
  return /^[a-z0-9]/.test(v) ? w === v || w === v + "s" : w.startsWith(v);
}

// Ключевая фраза совпадает, если каждое её слово (или эквивалент) есть в заголовке.
function keywordMatches(titleWords, keyword) {
  return normalize(keyword)
    .split(" ")
    .every((kw) => variants(kw).some((v) => titleWords.some((w) => wordHits(w, v))));
}

export function matches(title, { keywords, stopwords }) {
  const norm = normalize(title);
  // однословные стоп-слова расширяются словарём («аналитик» режет и analyst)
  const stopped = stopwords.some((sw) => {
    const s = normalize(sw);
    const forms = s.includes(" ") ? [s] : variants(s);
    return forms.some((f) => norm.includes(f));
  });
  if (stopped) return false;
  return matchesKeywords(norm, keywords);
}

// Только ключевые слова, без стоп-слов — для длинных текстов (посты каналов),
// где одно упоминание стоп-слова не должно топить весь пост.
export function matchesKeywords(text, keywords) {
  const words = normalize(text).split(" ");
  return keywords.some((kw) => keywordMatches(words, kw));
}

// --- Структурные критерии: грейд и формат работы -----------------------------
// Канонические грейды. Слово названия сводится к грейду по префиксу.
const GRADE_WORDS = {
  стажер: "intern", intern: "intern", trainee: "intern",
  младший: "junior", джун: "junior", junior: "junior",
  мидл: "middle", миддл: "middle", middle: "middle",
  старший: "senior", сеньор: "senior", синьор: "senior", senior: "senior",
  ведущий: "lead", лид: "lead", lead: "lead", тимлид: "lead",
  стафф: "staff", staff: "staff",
  главный: "principal", principal: "principal", chief: "principal",
  руководитель: "head", глава: "head", head: "head",
  директор: "director", director: "director",
};

// Все грейды, упомянутые в тексте: «Middle/Senior Engineer» → [middle, senior].
export function inferGrades(text) {
  const found = new Set();
  for (const w of normalize(text).split(" ")) {
    for (const [key, grade] of Object.entries(GRADE_WORDS)) {
      if (w.startsWith(key)) found.add(grade);
    }
  }
  return [...found];
}

const DIRECTION_KEYWORDS = {
  "ml ai engineer": ["machine learning engineer", "ml engineer", "ai engineer", "искусственный интеллект", "машинного обучения", "машинное обучение"],
  "computer vision engineer": ["computer vision engineer", "cv engineer", "специалист компьютерного зрения", "инженер компьютерного зрения", "машинного зрения"],
  "nlp llm engineer": ["nlp engineer", "llm engineer", "генеративный ии", "обработки естественного языка", "языковых моделей"],
};

// Эффективный список ключевых слов роли: направления, раскрытые в матчащиеся
// слова, плюс явные ключевые слова пользователя. Используется и структурным
// фильтром, и телеграм-источником (он матчит по полному тексту поста).
export function roleKeywords(cfg) {
  const expanded = (cfg.directions || []).flatMap((d) => DIRECTION_KEYWORDS[normalize(d)] || [d]);
  return [...new Set([...expanded, ...(cfg.keywords || [])])];
}

// Разовые/неполные форматы найма: агент ищет постоянную работу — консультации,
// парт-тайм и фриланс режем по явным словам заголовка.
const GIG_RE = /consult|консульт|part[-\s]?time|парт[-\s]?тайм|фриланс|freelance|частичн\w{0,3}\s+занятост/i;
function gigOk(item) {
  return !GIG_RE.test(item.title || "");
}

const FORMAT_WORDS = {
  remote: ["удален", "remote", "дистанц"],
  hybrid: ["гибрид", "hybrid"],
  office: ["офис", "office", "onsite", "on site"],
};

// cfg.grades: ["senior","lead",...] — пусто/нет = любые. Метаданные источника
// (item.level) приоритетнее; иначе выводим из названия; неизвестно — не режем.
function gradeOk(item, grades) {
  if (!grades?.length) return true;
  const found = item.level
    ? inferGrades(String(item.level))
    : inferGrades(item.title);
  if (!found.length) return true;
  return found.some((g) => grades.includes(g));
}

// cfg.formats: ["remote","hybrid","office"] — пусто/нет = любые. Смотрим
// item.format + location + title; формат не упомянут — не режем.
function formatOk(item, formats) {
  if (!formats?.length) return true;
  const hay = normalize([item.format, item.location, item.title].filter(Boolean).join(" "));
  const present = Object.entries(FORMAT_WORDS)
    .filter(([, words]) => words.some((w) => hay.includes(w)))
    .map(([name]) => name);
  if (!present.length) return true;
  return present.some((f) => formats.includes(f));
}

// Полная проверка вакансии: ключевые слова + стоп-слова + грейд + формат.
//
// Если выбраны направления (cfg.directions), роль определяется ЧИСТЫМ
// заголовком: он должен матчить направление или фразу уровня, а грейд режет
// структурный фильтр gradeOk. Склеивать title+level здесь нельзя: у hirehi
// level=lead, и «коммуникационный дизайнер» превращался в «дизайн лида»
// (слова фразы добирались из level).
//
// Без направлений keywords матчатся по title + item.level: у многих карьерных
// сайтов грейд лежит отдельным полем (теги Т-Банка, level hirehi), а заголовок —
// просто «Продуктовый дизайнер»; без level такие вакансии не отобрать.
export function matchesItem(item, cfg) {
  const dirs = cfg.directions || [];
  const roleOk = dirs.length
    ? matches(item.title, { keywords: roleKeywords(cfg), stopwords: cfg.stopwords || [] })
    : matches(item.level ? `${item.title} ${item.level}` : item.title, cfg);
  return roleOk && structuralOk(item, cfg);
}

// Только структурные срезы, без ключевых слов — для prefiltered-источников
// (телеграм матчит ключевые слова по полному тексту поста сам, но грейд,
// область, формат и тип найма режутся по извлечённому заголовку здесь).
export function structuralOk(item, cfg) {
  return gradeOk(item, cfg.grades) && formatOk(item, cfg.formats) && gigOk(item);
}

// --- Межисточниковый дедуп ---------------------------------------------------
// Одна вакансия часто приходит и из прямого источника (hh, hirehi), и из
// телеграм-поста, который на неё ссылается. Ключ дедупа — целевая ссылка
// (applyUrl приоритетнее url) без протокола, www, трекинг-параметров и хвоста.
const TRACKING = /\b(utm_[a-z]+|rcm|ref|fbclid|gclid|yclid|_ga|share|origin)=[^&]*/gi;

export function targetKey(item) {
  const raw = item.applyUrl || item.url || "";
  const stripped = raw.toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/#.*$/, "")
    .replace(TRACKING, "")
    .replace(/[?&]+$/, "").replace(/\/+$/, "");
  return stripped || `${item.source}:${item.id}`; // нет ссылки — не сливаем
}

// Текстовый ключ для телеграм-постов БЕЗ внешней ссылки: один и тот же пост в
// двух каналах имеет разные t.me-url, по ссылке его не схлопнуть. Ключ —
// нормализованные заголовок+компания; короткие générique-заголовки («Дизайнер»)
// не сливаем, чтобы не склеить разные вакансии.
export function textKey(item) {
  if (item.source !== "telegram" || item.applyUrl) return "";
  const t = normalize(item.title);
  if (t.length < 20) return "";
  return `txt:${t}|${normalize(item.company || "")}`;
}

// Убрать дубли по целевой ссылке. При совпадении предпочитаем прямой источник
// (у него структурные поля: грейд, зарплата) телеграм-посту.
export function dedupeByTarget(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = targetKey(item);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, item); continue; }
    const prevTg = prev.source === "telegram";
    const curTg = item.source === "telegram";
    if (prevTg && !curTg) byKey.set(key, item); // прямой источник вытесняет телегу
  }
  // второй проход: дубли одного поста в разных каналах (по тексту)
  const byText = new Map();
  const out = [];
  for (const item of byKey.values()) {
    const tk = textKey(item);
    if (tk) {
      if (byText.has(tk)) continue;
      byText.set(tk, item);
    }
    out.push(item);
  }
  return out;
}
