#!/usr/bin/env node
// Локальный пульт управления: лента находок, тумблеры источников, критерии,
// кнопка «прогнать сейчас». Слушает только 127.0.0.1 — наружу ничего не торчит.
// Секреты (.env) не читаются и не отдаются: правим только config.json.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, projectRoot } from "./lib/env.mjs";
import { loadJobs, setJobStatus, setJobLetter, addJob, deleteJob } from "./lib/state.mjs";
import { inferGrades, matchesItem } from "./lib/filter.mjs";
import { discoverSources } from "./lib/registry.mjs";
import { telegramConfigured } from "./lib/telegram.mjs";
import { runPipeline } from "./lib/run.mjs";

loadEnv();

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4321;
const uiDir = join(dirname(fileURLToPath(import.meta.url)), "ui");
const configPath = join(projectRoot, "config.json");

// Воронка трекинга откликов (порядок = порядок в выпадашке статуса).
// Вне воронки: «Новая» (в ленте вакансий, статус по умолчанию) и «Скрыта»
// (не интересна — не показывать).
const STATUSES = ["Новый", "Отклик", "Без ответа", "Собес", "Тестовое", "Оффер", "Отказ", "Архив"];
const ALL_STATUSES = ["Новая", "Скрыта", ...STATUSES];

// Лента «Вакансии» живёт по ТЕКУЩИМ критериям: у новых вакансий считаем флаг
// соответствия конфигу — UI скрывает не подходящие, не удаляя их из архива.
// Снял галочку направления → его находки ушли из ленты; вернул — вернулись.
function withStatus(jobs, cfg) {
  return jobs.map((j) => {
    const status = j.status || "Новая";
    const rec = { ...j, status };
    // ручное под критерии не проверяем: пользователь завёл запись сам, она не
    // должна пропадать из ленты из-за несовпадения с keywords
    if (cfg && status === "Новая" && j.source !== "manual") rec.matchesNow = matchesItem(j, cfg);
    return rec;
  });
}

function loadConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

// --- уровни (лестница грейдов) ----------------------------------------------
// У каждого уровня свои ключевые фразы; включённые уровни дают плоский
// cfg.keywords для сборщика (плюс направления, их UI шлёт в keywords сам).
const LEVEL_ORDER = ["intern", "junior", "middle", "senior", "lead", "head"];
// канонические грейды структурного фильтра (см. GRADE_WORDS в lib/filter.mjs)
const KNOWN_GRADES = ["intern", "junior", "middle", "senior", "staff", "lead", "principal", "head", "director"];
const GRADE_TO_LEVEL = {
  intern: "intern", junior: "junior", middle: "middle", senior: "senior",
  lead: "lead", staff: "senior", principal: "head", head: "head", director: "head",
};
const LEVEL_DEFAULT_KEYWORDS = {
  intern: ["стажер дизайнер", "стажер ux", "стажер ui", "дизайн стажировка", "design intern"],
  junior: ["джуниор дизайнер", "младший дизайнер", "начинающий дизайнер", "junior ux", "junior ui", "junior designer"],
  middle: ["мидл дизайнер", "middle ux", "middle ui", "middle designer", "middle product designer"],
  senior: ["старший дизайнер", "senior ux", "senior ui", "senior designer", "senior product designer"],
  lead: ["дизайн лид", "лид дизайнер", "ведущий дизайнер", "главный дизайнер", "lead ux", "design lead", "lead product designer"],
  head: ["руководитель дизайна", "дизайн директор", "head of design", "design director", "арт-директор"],
};

function levelsFor(cfg) {
  const saved = Array.isArray(cfg.levels) ? cfg.levels : [];
  if (saved.length) {
    return LEVEL_ORDER.map((name) =>
      saved.find((l) => l.name === name) ||
      { name, on: false, keywords: LEVEL_DEFAULT_KEYWORDS[name] });
  }
  // миграция со старого конфига: фразы с грейдом раскладываются по уровням
  const byLevel = Object.fromEntries(LEVEL_ORDER.map((n) => [n, []]));
  for (const kw of cfg.keywords || []) {
    for (const g of inferGrades(kw)) {
      const lvl = GRADE_TO_LEVEL[g];
      if (lvl && !byLevel[lvl].includes(kw)) byLevel[lvl].push(kw);
    }
  }
  return LEVEL_ORDER.map((name) => ({
    name,
    on: byLevel[name].length > 0,
    keywords: byLevel[name].length ? byLevel[name] : LEVEL_DEFAULT_KEYWORDS[name],
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("тело запроса слишком большое"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// Приводим присланный конфиг к безопасному виду и вливаем в существующий,
// сохраняя секции delivery/telegram, которые UI не трогает.
// Невалидное — явная ошибка (400), а не молчаливое обнуление критериев.
const MAX_WORD = 80;    // максимум символов на одно слово-критерий
const MAX_LIST = 200;   // максимум элементов в списке

function validateList(v, field) {
  if (!Array.isArray(v)) throw new Error(`${field}: ожидается массив строк`);
  if (v.length > MAX_LIST) throw new Error(`${field}: слишком много элементов (${v.length} > ${MAX_LIST})`);
  const bad = v.find((s) => typeof s !== "string" || s.length > MAX_WORD);
  if (bad !== undefined) throw new Error(`${field}: элемент не строка или длиннее ${MAX_WORD} символов`);
  return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
}

function applyConfigPatch(current, patch, knownSources) {
  const next = { ...current };
  if ("onboarded" in patch) next.onboarded = !!patch.onboarded;
  if ("keywords" in patch) next.keywords = validateList(patch.keywords, "keywords");
  if ("directions" in patch) next.directions = validateList(patch.directions, "directions");
  if ("stopwords" in patch) next.stopwords = validateList(patch.stopwords, "stopwords");
  if ("sources" in patch) {
    if (!patch.sources || typeof patch.sources !== "object" || Array.isArray(patch.sources)) {
      throw new Error("sources: ожидается объект {имя: вкл}");
    }
    const unknown = Object.keys(patch.sources).filter((n) => !knownSources.has(n));
    if (unknown.length) throw new Error(`sources: неизвестные источники: ${unknown.join(", ")}`);
    next.sources = { ...current.sources };
    for (const [name, on] of Object.entries(patch.sources)) next.sources[name] = !!on;
  }
  if ("tgDisabled" in patch) {
    next.telegram = { ...current.telegram, disabled: validateList(patch.tgDisabled, "tgDisabled") };
  }
  if ("levels" in patch) {
    if (!Array.isArray(patch.levels)) throw new Error("levels: ожидается массив");
    next.levels = patch.levels
      .map((l) => ({ name: String(l?.name || "").trim(), on: !!l?.on, keywords: validateList(l?.keywords ?? [], "levels.keywords") }))
      .filter((l) => LEVEL_ORDER.includes(l.name));
  }
  if ("grades" in patch) {
    const bad = validateList(patch.grades, "grades").filter((g) => !KNOWN_GRADES.includes(g));
    if (bad.length) throw new Error(`grades: неизвестные грейды: ${bad.join(", ")}`);
    next.grades = validateList(patch.grades, "grades");
  }
  if ("formats" in patch) {
    const KNOWN_FORMATS = ["remote", "hybrid", "office"];
    const list = validateList(patch.formats, "formats");
    const bad = list.filter((f) => !KNOWN_FORMATS.includes(f));
    if (bad.length) throw new Error(`formats: неизвестные форматы: ${bad.join(", ")}`);
    next.formats = list;
  }
  return next;
}

let running = false;
let currentLog = [];    // лог идущего/последнего прогона — для /api/progress
let sourcesTotal = 0;   // сколько источников включено в идущем прогоне

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);

  // --- статика (одна страница) ---------------------------------------------
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = readFileSync(join(uiDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      return json(res, 500, { error: "ui/index.html не найден" });
    }
  }

  // --- состояние: конфиг + источники + лента --------------------------------
  if (req.method === "GET" && url.pathname === "/api/state") {
    let cfg;
    try {
      cfg = loadConfig();
    } catch {
      return json(res, 200, { needsSetup: true });
    }
    const known = (await discoverSources()).map((s) => s.name);
    const sources = known.map((name) => ({ name, enabled: cfg.sources?.[name] !== false }));
    const tgOff = new Set(cfg.telegram?.disabled || []);
    const tgChannels = (cfg.telegram?.channels || []).map((name) => ({
      name,
      enabled: !tgOff.has(name),
    }));
    return json(res, 200, {
      // первый запуск: критерии ещё не выбраны — пульт показывает экран онбординга
      // вместо ленты. Старые конфиги ключа не имеют и считаются настроенными.
      onboarded: cfg.onboarded !== false,
      keywords: cfg.keywords || [],
      directions: cfg.directions || [],
      stopwords: cfg.stopwords || [],
      formats: cfg.formats || [],
      levels: levelsFor(cfg),
      sources,
      tgChannels,
      statuses: STATUSES,
      telegramConfigured: telegramConfigured(),
      jobs: withStatus(loadJobs(), cfg),
    });
  }

  // --- сохранить критерии/тумблеры -----------------------------------------
  if (req.method === "POST" && url.pathname === "/api/config") {
    let patch;
    try {
      patch = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { error: /большое/.test(e.message) ? e.message : "невалидный JSON" });
    }
    let current;
    try {
      current = loadConfig();
    } catch {
      return json(res, 400, { error: "нет config.json — запусти npm run setup" });
    }
    let next;
    try {
      const knownSources = new Set((await discoverSources()).map((s) => s.name));
      next = applyConfigPatch(current, patch, knownSources);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
    return json(res, 200, { ok: true });
  }

  // --- сменить статус трекинга ----------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/status") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "невалидный JSON" });
    }
    if (!ALL_STATUSES.includes(body.status)) {
      return json(res, 400, { error: "неизвестный статус" });
    }
    const ok = setJobStatus(body.source, body.id, body.status);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "вакансия не найдена" });
  }

  // --- добавить отклик вручную ----------------------------------------------
  // Для найденного руками (LinkedIn и пр.). Кладём сразу в воронку откликов.
  if (req.method === "POST" && url.pathname === "/api/job") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "невалидный JSON" });
    }
    // строковое поле с ограничением длины; пустое — не сохраняем вовсе
    const str = (val, field, max) => {
      if (val === undefined || val === null || val === "") return "";
      if (typeof val !== "string") throw new Error(`${field}: ожидается строка`);
      const s = val.trim();
      if (s.length > max) throw new Error(`${field}: длиннее ${max} символов`);
      return s;
    };
    let rec;
    try {
      const title = str(body.title, "title", 300);
      if (!title) throw new Error("title: должность обязательна");
      const status = body.status || "Отклик";
      if (!STATUSES.includes(status)) throw new Error("status: неизвестный статус");
      const format = str(body.format, "format", 40).toLowerCase();
      if (format && !["удалённо", "гибрид", "офис"].includes(format)) {
        throw new Error("format: неизвестный формат работы");
      }
      const published = str(body.published, "published", 40);
      if (published && isNaN(Date.parse(published))) throw new Error("published: не дата");
      const level = str(body.level, "level", 20).toLowerCase();
      if (level && !LEVEL_ORDER.includes(level)) throw new Error("level: неизвестный грейд");
      rec = {
        title,
        company: str(body.company, "company", 200),
        url: /^https?:\/\//i.test(body.url || "") ? str(body.url, "url", 2000) : "",
        letter: str(body.letter, "letter", 20000),
        level,                      // gradeOf() в UI берёт грейд отсюда
        location: format,           // workFormat() в UI читает формат отсюда
        published: published || new Date().toISOString(),
        status,
      };
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    for (const k of Object.keys(rec)) if (rec[k] === "") delete rec[k];
    const job = addJob(rec);
    const cfg = (() => { try { return loadConfig(); } catch { return null; } })();
    return json(res, 200, { ok: true, job, jobs: withStatus(loadJobs(), cfg) });
  }

  // --- удалить ручной отклик -------------------------------------------------
  // Только source=manual: у собранных ключ уже в seen.json, повторно они не
  // придут — удаление было бы безвозвратным. Для них есть возврат в ленту.
  if (req.method === "POST" && url.pathname === "/api/job/delete") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "невалидный JSON" });
    }
    if (body.source !== "manual") {
      return json(res, 400, { error: "удалять можно только отклики, добавленные вручную" });
    }
    const ok = deleteJob(body.source, body.id);
    if (!ok) return json(res, 404, { error: "запись не найдена" });
    const cfg = (() => { try { return loadConfig(); } catch { return null; } })();
    return json(res, 200, { ok: true, jobs: withStatus(loadJobs(), cfg) });
  }

  // --- сопроводительное письмо отклика --------------------------------------
  if (req.method === "POST" && url.pathname === "/api/letter") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "невалидный JSON" });
    }
    if (typeof body.letter !== "string" || body.letter.length > 20000) {
      return json(res, 400, { error: "letter: ожидается строка до 20000 символов" });
    }
    const ok = setJobLetter(body.source, body.id, body.letter);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "вакансия не найдена" });
  }

  // --- живой прогресс текущего прогона (поллится кнопкой в пульте) ----------
  if (req.method === "GET" && url.pathname === "/api/progress") {
    return json(res, 200, { running, log: currentLog, total: sourcesTotal });
  }

  // --- прогнать сбор сейчас -------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/run") {
    if (running) return json(res, 409, { error: "прогон уже идёт" });
    running = true;
    const log = [];
    currentLog = log;
    try {
      const cfg = loadConfig();
      sourcesTotal = (await discoverSources())
        .filter((s) => cfg.sources?.[s.name] !== false).length;
      const { fresh, errors } = await runPipeline(cfg, { onLog: (m) => log.push(m) });
      return json(res, 200, { found: fresh.length, errors, log, jobs: withStatus(loadJobs(), cfg) });
    } catch (e) {
      return json(res, 500, { error: e.message, log });
    } finally {
      running = false;
    }
  }

  json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: e.message }));
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Порт ${PORT} занят — скорее всего, пульт уже запущен: http://${HOST}:${PORT}`);
    console.error(`Проверить: npm run service status. Другой порт: PORT=4322 npm run ui`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`sasaki-agent UI → http://${HOST}:${PORT}`);
});

// Под супервизором (launchd KeepAlive) сами выходим при изменении кода: ES-модули
// кешируются в процессе, поэтому после git pull старый процесс продолжал бы
// отдавать прежнюю версию. Вышли — супервизор поднял уже с новым кодом.
// Вручную запущенный сервер так не делает: его никто не поднимет обратно.
if (process.env.SASAKI_SUPERVISED) {
  let timer = null;
  const bump = (file) => {
    if (file && !/\.(mjs|html)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[ui] код изменился (${file || "src"}) — перезапуск`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref(); // не ждём висящие соединения
    }, 700); // дебаунс: git pull трогает много файлов подряд
  };
  try {
    watch(join(projectRoot, "src"), { recursive: true }, (_ev, file) => bump(file));
  } catch {
    // recursive не везде поддерживается — следим за ключевыми папками поштучно
    for (const d of ["src", "src/lib", "src/sources", "src/ui", "src/deliver"]) {
      try { watch(join(projectRoot, d), (_ev, file) => bump(file)); } catch { /* нет папки */ }
    }
  }
}
