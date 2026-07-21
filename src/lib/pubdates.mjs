// Кэш дат публикации для источников, где дата есть только на странице/карточке
// отдельной вакансии (яндекс, авито): в списке даты нет, а ходить за каждой
// вакансией в каждый прогон — дорого. Поэтому дата добывается ОДИН раз для
// нового id, дальше берётся из data/pub-dates.json. Записи для id, пропавших
// из выдачи, вычищаются — файл не растёт бесконечно.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./env.mjs";

const cachePath = join(projectRoot, "data", "pub-dates.json");

function loadCache() {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  mkdirSync(join(projectRoot, "data"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
}

// Проставить items[].published: для незнакомых id зовёт fetchDate(item)
// (1 сетевой запрос), результат кэширует. Ошибка добычи не кэшируется —
// попробуем в следующий прогон; сам сбор из-за даты не валим.
export async function withPubDates(source, items, fetchDate) {
  const cache = loadCache();
  const known = cache[source] || {};
  const next = {};
  for (const item of items) {
    if (!(item.id in known)) {
      try {
        known[item.id] = (await fetchDate(item)) || "";
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        // сеть/вёрстка подвели — оставим published пустым до следующего прогона
      }
    }
    if (item.id in known) next[item.id] = known[item.id];
    item.published = next[item.id] || "";
  }
  cache[source] = next; // держим только id из текущей выдачи
  saveCache(cache);
  return items;
}
