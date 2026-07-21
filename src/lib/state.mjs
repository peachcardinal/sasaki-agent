import {
  readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync,
  openSync, closeSync, unlinkSync, statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { projectRoot } from "./env.mjs";
import { matchesItem, targetKey } from "./filter.mjs";

const dataDir = join(projectRoot, "data");
const statePath = join(dataDir, "seen.json");
const jobsPath = join(dataDir, "jobs.json");
const lockPath = join(dataDir, ".lock");

// --- безопасная работа с файлами ---------------------------------------------
// Битый JSON не превращаем молча в пустоту: иначе следующая запись затёрла бы
// весь архив. Копируем повреждённый файл в *.corrupt-* и останавливаем прогон.
function readJson(path, fallback) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return fallback; // файла нет — свежая установка
  }
  try {
    return JSON.parse(raw);
  } catch {
    const bak = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, bak);
    throw new Error(
      `${basename(path)} повреждён — копия сохранена в ${basename(bak)}, запись остановлена, чтобы не затереть данные`
    );
  }
}

// Атомарная запись: во временный файл + rename. Упавший на середине процесс
// не оставит обрезанный JSON на месте рабочего файла.
function writeJsonAtomic(path, value) {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// Межпроцессная блокировка read-modify-write: крон (collect.mjs) и «Найти
// вакансии» из пульта могут писать одновременно. Лок — эксклюзивное создание
// файла; протухший (владелец умер, >30 с) сносим. Ожидание синхронное —
// вызывающий код синхронный.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(fn) {
  mkdirSync(dataDir, { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    let fd;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // лок исчез между проверками — пробуем снова
      }
      if (Date.now() > deadline) throw new Error("data/.lock занят другим прогоном — попробуй позже");
      sleep(120);
      continue;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

// seen.json: { "<source>:<id>": "<ISO дата отправки>" }
export function loadSeen() {
  return new Map(Object.entries(readJson(statePath, {})));
}

// Сливаем с текущим содержимым под локом: пока шёл долгий сбор, параллельный
// прогон мог дописать свои ключи — их не затираем.
export function saveSeen(seen) {
  withLock(() => {
    const current = new Map(Object.entries(readJson(statePath, {})));
    for (const [k, v] of seen) current.set(k, v);
    writeJsonAtomic(statePath, Object.fromEntries(current));
  });
}

// jobs.json: архив найденных вакансий целиком (для ленты в UI), новые сверху.
// Потолок архива. Рост и так ограничен протуханием (retentionDays), поэтому
// потолок — страховка от разрастания файла, а не рабочий лимит: при широком
// поиске месяц выдачи легко превышает пару сотен, и низкий потолок незаметно
// срезал бы ленту.
const JOBS_CAP = 2000;

export function loadJobs() {
  const arr = readJson(jobsPath, []);
  return Array.isArray(arr) ? arr : [];
}

// Дозаписать свежие находки, дедуп по source:id, обрезка до JOBS_CAP.
// Статус не ставим: без статуса = «Новая» (лента вакансий); в воронку
// откликов запись попадает, когда пользователь жмёт «В отклики» в пульте.
// Кап режет только «Новые»: записи со статусом (отклики, скрытые) — трекинг
// пользователя, их не выбрасываем, даже если их больше капа.
export function appendJobs(items) {
  if (!items?.length) return;
  const collectedAt = new Date().toISOString();
  withLock(() => {
    const existing = loadJobs();
    const have = new Set(existing.map((v) => `${v.source}:${v.id}`));
    // Дедуп по source:id ловит только повтор из ТОГО ЖЕ источника. Одна вакансия
    // приходит и из телеграм-поста, и из прямого источника — id у них разные, и
    // без проверки по ссылке в ленте появлялись две карточки на одну вакансию.
    // dedupeByTarget этот случай закрывает только ВНУТРИ прогона: если телега
    // принесла её вчера, а hh отдал сегодня, там сравнивать не с чем.
    const byTarget = new Map();
    for (const v of existing) {
      const k = targetKey(v);
      if (k) byTarget.set(k, v);
    }
    const fresh = [];
    for (const v of items) {
      if (have.has(`${v.source}:${v.id}`)) continue;
      const k = targetKey(v);
      const twin = k && byTarget.get(k);
      if (twin) {
        // Статус — это трекинг пользователя (отклик, письмо, скрытие): такую
        // запись не трогаем и вторую карточку не заводим. Иначе действует то же
        // правило, что в dedupeByTarget: прямой источник вытесняет телеграм.
        if (!twin.status && twin.source === "telegram" && v.source !== "telegram") {
          Object.assign(twin, v, { collectedAt: twin.collectedAt });
        }
        continue;
      }
      const rec = { ...v, collectedAt };
      if (k) byTarget.set(k, rec);
      fresh.push(rec);
    }
    let merged = [...fresh, ...existing];
    if (merged.length > JOBS_CAP) {
      const tracked = merged.filter((j) => j.status).length;
      let room = Math.max(0, JOBS_CAP - tracked);
      merged = merged.filter((j) => j.status || room-- > 0);
    }
    writeJsonAtomic(jobsPath, merged);
  });
}

// Протухание ленты: чистим только записи БЕЗ статуса («Новые» — отклики и
// скрытые не трогаем). Уходят: (а) старше retentionDays (по collectedAt),
// (б) не-prefiltered записи, переставшие подходить под ТЕКУЩИЕ критерии —
// пользователь сменил критерии, старая выдача не должна засорять ленту.
// Prefiltered (hirehi, telegram) по критериям не проверяем — их фильтры живут
// в конфиге источника, keywords к ним неприменимы; их чистит только TTL.
export function pruneJobs(cfg) {
  return withLock(() => {
    const jobs = loadJobs();
    const ttlMs = (Number(cfg.retentionDays) || 30) * 24 * 3600 * 1000;
    const now = Date.now();
    const kept = jobs.filter((j) => {
      if (j.source === "manual") return true; // ручное — данные пользователя, не протухают
      if (j.status) return true;
      const born = Date.parse(j.collectedAt || "") || now;
      if (now - born > ttlMs) return false;
      if (!j.prefiltered && !matchesItem(j, cfg)) return false;
      return true;
    });
    if (kept.length !== jobs.length) writeJsonAtomic(jobsPath, kept);
    return jobs.length - kept.length;
  });
}

// Ручной отклик — то, что нашли руками (LinkedIn и пр.), а не сборщиком.
// Источник "manual", id генерируем сами. Статус проставляет вызывающий и он
// обязателен: pruneJobs чистит только записи БЕЗ статуса, так что ручная
// запись не протухнет и не будет проверяться по keywords.
export function addJob(rec) {
  return withLock(() => {
    const jobs = loadJobs();
    const job = {
      ...rec,
      source: "manual",
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      collectedAt: new Date().toISOString(),
    };
    writeJsonAtomic(jobsPath, [job, ...jobs]);
    return job;
  });
}

// Удалить запись насовсем. Осмысленно только для ручных: собранную вакансию
// «удалить» нельзя — её ключ лежит в seen.json, повторно она не придёт, а
// вернуть её будет неоткуда. Для собранных есть возврат в ленту (статус «Новая»).
export function deleteJob(source, id) {
  return withLock(() => {
    const jobs = loadJobs();
    const kept = jobs.filter((j) => !(j.source === source && String(j.id) === String(id)));
    if (kept.length === jobs.length) return false;
    writeJsonAtomic(jobsPath, kept);
    return true;
  });
}

// Сменить статус трекинга у одной вакансии. Возвращает true, если нашли.
// «Новая» = отсутствие статуса — поле убираем, а не храним строку.
export function setJobStatus(source, id, status) {
  return withLock(() => {
    const jobs = loadJobs();
    const rec = jobs.find((j) => j.source === source && String(j.id) === String(id));
    if (!rec) return false;
    if (status === "Новая") delete rec.status;
    else rec.status = status;
    writeJsonAtomic(jobsPath, jobs);
    return true;
  });
}

// Сопроводительное письмо отклика; пустая строка удаляет поле.
export function setJobLetter(source, id, letter) {
  return withLock(() => {
    const jobs = loadJobs();
    const rec = jobs.find((j) => j.source === source && String(j.id) === String(id));
    if (!rec) return false;
    if (letter) rec.letter = letter;
    else delete rec.letter;
    writeJsonAtomic(jobsPath, jobs);
    return true;
  });
}
