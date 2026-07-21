#!/usr/bin/env node
// Мастер настройки: собирает config.json и .env под пользователя,
// ставит расписание и делает тестовый прогон. Запуск: npm run setup
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./lib/env.mjs";
import { discoverSources, discoverDeliverers } from "./lib/registry.mjs";
import { install as installService, SERVICES, linuxHints } from "./lib/service.mjs";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = "") => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
async function askYes(q, def = true) {
  const a = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
  return a.startsWith("y") || a.startsWith("д");
}

const cfgPath = join(projectRoot, "config.json");
const envPath = join(projectRoot, ".env");

console.log("\n🔎 sasaki-agent — настройка\n" + "─".repeat(40));

// --- 1. Критерии поиска ---------------------------------------------------
const cfg = JSON.parse(readFileSync(join(projectRoot, "config.example.json"), "utf8"));
if (existsSync(cfgPath)) {
  console.log("Найден существующий config.json — беру его за основу.");
  Object.assign(cfg, JSON.parse(readFileSync(cfgPath, "utf8")));
}

console.log(
  "\n1/5 · Какие роли ищем?\n" +
  "Перечисли через запятую — это фразы, которые должны встречаться в названии\n" +
  "вакансии. Слова матчатся по префиксу («дизайнер» найдёт «дизайнера»),\n" +
  "русский и английский — взаимозаменяемы («дизайн лид» найдёт «Design Lead»)."
);
const kw = await ask("Ключевые фразы", cfg.keywords.join(", "));
cfg.keywords = kw.split(",").map((s) => s.trim()).filter(Boolean);

console.log(
  "Стоп-слова режут вакансию при ЛЮБОМ упоминании: стоп «middle» убьёт и\n" +
  "«Middle/Senior». Нижний грейд лучше держать грейдами (следующий вопрос),\n" +
  "а стопами — тематику (чужие профессии, интерьеры...)."
);
const sw = await ask("Стоп-слова (режут вакансию целиком)", cfg.stopwords.join(", "));
cfg.stopwords = sw.split(",").map((s) => s.trim()).filter(Boolean);

console.log(
  "\nГрейды: intern / junior / middle / senior / lead / staff / principal / head / director.\n" +
  "Вакансия с известным грейдом (из метаданных источника или из названия) должна\n" +
  "попасть в список; «Middle/Senior» пройдёт, если senior разрешён. Enter — любые."
);
const gr = await ask("Грейды через запятую", (cfg.grades || []).join(", "));
cfg.grades = gr.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const fm = await ask("Формат работы: remote / hybrid / office (Enter — любой)", (cfg.formats || []).join(", "));
cfg.formats = fm.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// --- 2. Источники -----------------------------------------------------------
console.log("\n2/5 · Источники (свои сайты добавляются агентом — скилл /add-source)");
const names = (await discoverSources()).map((s) => s.name);
names.forEach((n, i) =>
  console.log(`  ${i + 1}. ${n}${cfg.sources?.[n] === false ? " (выкл)" : ""}`)
);
const off = await ask("Номера источников, которые ВЫКЛЮЧИТЬ (через запятую, Enter — оставить все)", "");
const offNums = new Set(off.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean));
cfg.sources = Object.fromEntries(
  names.map((n, i) => [n, !offNums.has(i + 1) && cfg.sources?.[n] !== false])
);

// --- 3. Доставка --------------------------------------------------------------
console.log("\n3/5 · Куда доставлять находки? (можно несколько, через запятую)");
const channels = (await discoverDeliverers()).map((d) => d.name);
const hints = {
  telegram: "сообщением в твоего телеграм-бота",
  markdown: "markdown-файлами в папку (укажи папку Obsidian vault — будет в заметках)",
  csv: "таблица-трекер откликов (Excel / импорт в Google Sheets)",
  webhook: "Slack / Discord / ntfy.sh (пуш на телефон)",
};
channels.forEach((n, i) => console.log(`  ${i + 1}. ${n} — ${hints[n] || ""}`));
const defChannels = cfg.delivery?.channels?.length ? cfg.delivery.channels : ["telegram", "markdown"];
const pickRaw = await ask(
  "Номера каналов",
  defChannels.map((c) => channels.indexOf(c) + 1).filter((n) => n > 0).join(",")
);
cfg.delivery = cfg.delivery || {};
cfg.delivery.channels = pickRaw
  .split(",")
  .map((s) => channels[parseInt(s.trim(), 10) - 1])
  .filter(Boolean);

if (cfg.delivery.channels.includes("markdown")) {
  cfg.delivery.markdown = { dir: await ask("Папка для markdown", cfg.delivery.markdown?.dir || "out") };
}
if (cfg.delivery.channels.includes("csv")) {
  cfg.delivery.csv = { file: await ask("Путь CSV-файла", cfg.delivery.csv?.file || "out/vacancies.csv") };
}
if (cfg.delivery.channels.includes("webhook")) {
  cfg.delivery.webhook = {
    url: await ask("URL вебхука", cfg.delivery.webhook?.url || ""),
    format: await ask("Формат (slack/discord/text)", cfg.delivery.webhook?.format || "slack"),
  };
}

const env = loadEnvFile();
let tgToken = "";
if (cfg.delivery.channels.includes("telegram")) {
  console.log(
    "\nТелеграм-бот: в Telegram открой @BotFather → /newbot → скопируй токен.\n" +
    "Enter без токена — настроишь позже (npm run setup:telegram)."
  );
  tgToken = await ask("Токен бота", env.TELEGRAM_BOT_TOKEN || "");
}
if (tgToken) {
  env.TELEGRAM_BOT_TOKEN = tgToken;
  if (!env.TELEGRAM_CHAT_ID) {
    await ask("Теперь напиши своему боту любое сообщение и нажми Enter", "");
    try {
      const res = await fetch(`https://api.telegram.org/bot${tgToken}/getUpdates`);
      const json = await res.json();
      const chats = new Map();
      for (const u of json.result || []) {
        const c = u.message?.chat || u.channel_post?.chat;
        if (c) chats.set(c.id, c.username || c.title || c.first_name || "");
      }
      if (chats.size === 1) {
        env.TELEGRAM_CHAT_ID = String([...chats.keys()][0]);
        console.log(`Чат найден: ${[...chats.values()][0]} (${env.TELEGRAM_CHAT_ID})`);
      } else if (chats.size > 1) {
        [...chats].forEach(([id, name], i) => console.log(`  ${i + 1}. ${name} (${id})`));
        const pick = parseInt(await ask("Какой чат использовать (номер)", "1"), 10) - 1;
        env.TELEGRAM_CHAT_ID = String([...chats.keys()][pick] ?? [...chats.keys()][0]);
      } else {
        console.log("Сообщений не видно — chat_id можно добавить позже: npm run setup:telegram");
      }
    } catch (e) {
      console.log(`Не получилось узнать chat_id (${e.message}) — позже: npm run setup:telegram`);
    }
  }
}

// --- 4. Токены источников ---------------------------------------------------
console.log(
  "\n4/5 · Токены источников (всё опционально, Enter — пропустить)\n" +
  "hh.ru — самый важный источник: покрывает и компании с закрытыми сайтами\n" +
  "(Сбер, Контур, Озон). Как получить токен — README, раздел «hh.ru»."
);
const hh = await ask("HH_TOKEN", env.HH_TOKEN || "");
if (hh) {
  env.HH_TOKEN = hh;
} else if (cfg.sources) {
  // без токена hh.ru падал бы с ошибкой на каждом прогоне — выключаем,
  // включить обратно = добавить HH_TOKEN в .env и снять галку в пульте
  cfg.sources.hh = false;
  console.log("Токена нет — hh.ru пока выключен (включится, когда добавишь HH_TOKEN).");
}

if (cfg.sources?.telegram !== false) {
  console.log(
    "\nТелеграм-каналы с вакансиями (публичные — без ключей и аккаунта).\n" +
    "Перечисли через запятую: @handle или ссылку t.me/handle."
  );
  const chans = await ask("Каналы", (cfg.telegram?.channels || []).join(", "));
  cfg.telegram = { channels: chans.split(",").map((s) => s.trim()).filter(Boolean) };
}

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
saveEnvFile(env);
console.log(`\n✓ config.json и .env записаны`);

// --- 5. Автозапуск -------------------------------------------------------------
console.log(
  "\n5/5 · Автозапуск\n" +
  "Сборщик будет ходить по источникам раз в 6 часов, а пульт — всегда висеть\n" +
  "на localhost и подниматься сам после перезагрузки. Запускать руками не нужно."
);
if (process.platform === "darwin") {
  if (await askYes("Установить автозапуск сейчас?")) {
    for (const kind of ["collect", "ui"]) {
      const path = installService(kind);
      console.log(`✓ ${SERVICES[kind].title}\n  ${path}`);
    }
    console.log("  Статус: npm run service · снять: npm run service uninstall");
  }
} else {
  console.log(linuxHints());
}

// --- Тестовый прогон ----------------------------------------------------------
if (await askYes("\nСделать тестовый прогон прямо сейчас?")) {
  console.log("");
  spawnSync(process.execPath, [join(projectRoot, "src/collect.mjs")], { stdio: "inherit" });
}

console.log("\nГотово. Править критерии — config.json, перезапускать ничего не надо.");
rl.close();

// --- helpers -------------------------------------------------------------------
function loadEnvFile() {
  const env = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

function saveEnvFile(env) {
  writeFileSync(
    envPath,
    Object.entries(env)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}
