// Пайплайн одного прогона: собрать → отфильтровать → отсеять виденное →
// доставить → заархивировать. Используется и кроном (collect.mjs), и UI-сервером.
import { matchesItem, structuralOk, dedupeByTarget, targetKey, textKey } from "./filter.mjs";
import { loadSeen, saveSeen, appendJobs, pruneJobs } from "./state.mjs";
import { sendTelegram, telegramConfigured, escapeHtml } from "./telegram.mjs";
import { discoverSources, discoverDeliverers } from "./registry.mjs";

// Сетевые сбои у сайтов-источников случаются: у части из них перед бэкендом
// стоит защита, которая иногда не принимает соединение (UND_ERR_CONNECT_TIMEOUT),
// и следующая же попытка проходит. Такие ошибки ретраим, ошибки настройки
// (нет токена) — нет, они детерминированные.
const RETRIABLE = /fetch failed|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|network|HTTP 5\d\d|HTTP 429/i;
const RETRIES = 2;        // всего до 3 попыток на источник
const RETRY_PAUSE = 1500; // мс между попытками

async function fetchWithRetry(src, cfg, log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await src.fetch(cfg);
    } catch (e) {
      const last = attempt >= RETRIES;
      if (last || !RETRIABLE.test(e.message)) throw e;
      log(`[${src.name}] сбой сети (${e.message}) — повтор ${attempt + 1}/${RETRIES}`);
      await new Promise((r) => setTimeout(r, RETRY_PAUSE));
    }
  }
}

// onLog — куда писать прогресс (по умолчанию в консоль; сервер собирает в массив).
export async function runPipeline(cfg, { onLog = console.log } = {}) {
  const log = (msg) => onLog(msg);

  // --- сбор -----------------------------------------------------------------
  const all = [];
  const errors = [];
  for (const src of await discoverSources()) {
    if (cfg.sources?.[src.name] === false) continue;
    log(`[${src.name}] запрашиваю…`);
    try {
      const items = await fetchWithRetry(src, cfg, log);
      log(`[${src.name}] получено: ${items.length}`);
      all.push(...items);
    } catch (e) {
      log(`[${src.name}] ошибка: ${e.message}`);
      errors.push(`${src.name}: ${e.message}`);
    }
  }

  // --- фильтр и дедуп -------------------------------------------------------
  const seen = loadSeen();
  // prefiltered-источники сматчили ключевые слова сами (по полному тексту),
  // но структурные срезы — грейд/область/формат/тип найма — применяем и к ним
  const matched = all.filter((v) => (v.prefiltered ? structuralOk(v, cfg) : matchesItem(v, cfg)));
  // межисточниковый дедуп: одна вакансия из телеги и из прямого источника — одна
  const deduped = dedupeByTarget(matched);
  const fresh = deduped.filter(
    (v) =>
      !seen.has(`${v.source}:${v.id}`) &&
      !seen.has(`url:${targetKey(v)}`) &&
      !(textKey(v) && seen.has(textKey(v))) // тот же пост из другого канала в прошлый прогон
  );
  log(`Совпало с критериями и ещё не отправлялось: ${fresh.length}`);

  // Архив ленты наполняем ВСЕМ, что подходит под текущие критерии, а не только
  // недоставленным. Иначе так: вакансия пришла → попала в seen → пользователь
  // сменил направление → протухание убрало её из ленты → вернул направление
  // обратно, но seen считает её доставленной, и в ленту она уже не вернётся
  // никогда. Доставка (уведомления) по-прежнему только по `fresh` — спама нет.
  // appendJobs дедуплицирует по source:id, повторов не будет.
  appendJobs(deduped);

  // --- доставка -------------------------------------------------------------
  if (fresh.length > 0) {
    const wanted = cfg.delivery?.channels?.length ? cfg.delivery.channels : ["markdown"];
    const deliverers = new Map((await discoverDeliverers()).map((d) => [d.name, d]));
    let deliveredSomewhere = false;
    for (const name of wanted) {
      const d = deliverers.get(name);
      if (!d) {
        log(`[${name}] неизвестный канал доставки`);
        continue;
      }
      try {
        await d.deliver({ items: fresh, errors }, cfg);
        deliveredSomewhere = true;
        log(`[${name}] доставлено`);
      } catch (e) {
        log(`[${name}] не сработал: ${e.message}`);
      }
    }
    // ничего не доставилось — страховочный markdown, чтобы находки не пропали
    if (!deliveredSomewhere) {
      await deliverers.get("markdown").deliver({ items: fresh, errors }, cfg);
      deliveredSomewhere = true;
      log("[markdown] страховочная доставка");
    }
    if (deliveredSomewhere) {
      const now = new Date().toISOString();
      for (const v of fresh) {
        seen.set(`${v.source}:${v.id}`, now);
        seen.set(`url:${targetKey(v)}`, now); // чтобы завтра та же вакансия из телеги не пришла повторно
        const tk = textKey(v);
        if (tk) seen.set(tk, now); // и тот же пост из другого канала
      }
      saveSeen(seen);
    }
  } else if (errors.length && telegramConfigured()) {
    // вакансий нет, но были сбои источников — сообщим, чтобы не молчать при поломке
    await sendTelegram(`⚠️ sasaki-agent: сбои источников\n${errors.map(escapeHtml).join("\n")}`).catch(() => {});
  }

  // --- протухание ленты -------------------------------------------------------
  // «Новые», которые устарели (retentionDays) или перестали подходить под
  // текущие критерии, убираем; отклики и скрытые не трогаем.
  try {
    const pruned = pruneJobs(cfg);
    if (pruned) log(`Протухло и убрано из ленты: ${pruned}`);
  } catch (e) {
    log(`[prune] не сработал: ${e.message}`);
  }

  return { fresh, errors };
}
