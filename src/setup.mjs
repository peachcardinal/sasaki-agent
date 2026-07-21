#!/usr/bin/env node
// Установка: ничего не спрашивает. Кладёт дефолтный config.json, ставит
// автозапуск, поднимает пульт и открывает браузер — критерии человек выберет
// на первом экране пульта, где сразу видно результат. Запуск: npm run setup
//
// Всё, что раньше было вопросами мастера, живёт в пульте: критерии и источники
// правятся галочками, доставка и токены — там же, когда понадобятся.
import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { projectRoot } from "./lib/env.mjs";
import { install as installService, SERVICES, linuxHints, uiResponds, UI_PORT } from "./lib/service.mjs";

// --- 0. Node ----------------------------------------------------------------
// Ниже 21 всё равно упадёт (Map.groupBy в сборщике) — лучше сказать сразу и внятно.
const MIN_NODE = 21;
const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  console.error(
    `\nНужен Node.js ${MIN_NODE} или новее, а сейчас ${process.versions.node}.\n` +
    "Поставь LTS с https://nodejs.org (или `brew install node`) и запусти `npm run setup` снова.\n"
  );
  process.exit(1);
}

const cfgPath = join(projectRoot, "config.json");
const uiUrl = `http://127.0.0.1:${UI_PORT}`;

console.log("\n🔎 sasaki-agent\n" + "─".repeat(40));

// --- 1. Конфиг ---------------------------------------------------------------
// Существующий не трогаем: у человека там уже свои критерии и правки из пульта.
if (existsSync(cfgPath)) {
  console.log("config.json уже есть — оставляю как есть.");
} else {
  copyFileSync(join(projectRoot, "config.example.json"), cfgPath);
  console.log("✓ config.json создан");
}

// --- 2. Автозапуск -----------------------------------------------------------
// Не спрашиваем: агент, которого надо звать руками, не агент. Снять — одной
// командой, о ней пишем ниже.
let uiSupervised = false;
if (process.platform === "darwin") {
  try {
    for (const kind of ["collect", "ui"]) installService(kind);
    uiSupervised = true;
    console.log(`✓ автозапуск: ${SERVICES.collect.title} и ${SERVICES.ui.title}`);
  } catch (e) {
    // в e.message от execSync лежит вся команда с путями — в консоль только суть
    console.log(`Автозапуск поставить не вышло (${e.message.split("\n")[0]}).`);
    console.log("Пульт подниму разово; поставить позже — npm run service install");
  }
} else {
  console.log("\nАвтозапуск на Linux — руками:\n");
  console.log(linuxHints());
  console.log("");
}

// --- 3. Пульт ----------------------------------------------------------------
// launchd поднимает пульт сам, но не мгновенно; если автозапуска нет — стартуем
// отдельным процессом, который переживёт выход из этого скрипта.
if (!(await waitForUi(uiSupervised ? 8000 : 0))) {
  const ui = spawn(process.execPath, [join(projectRoot, "src/server.mjs")], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  ui.on("error", () => { /* не стартовал — ниже скажем, как поднять руками */ });
  ui.unref();
  await waitForUi(8000);
}

if (await uiResponds()) {
  console.log(`✓ пульт работает → ${uiUrl}`);
  open(uiUrl);
} else {
  console.log(`Пульт не отозвался. Запусти вручную: npm run ui — и открой ${uiUrl}`);
}

console.log(
  "\nГотово. В пульте выбери, кого ищешь, и жми «Найти вакансии».\n" +
  "Дальше он ходит по источникам сам, раз в 6 часов.\n" +
  "\nСнять автозапуск: npm run service uninstall · статус: npm run service\n"
);

// --- helpers -----------------------------------------------------------------
async function waitForUi(ms) {
  const until = Date.now() + ms;
  while (true) {
    if (await uiResponds()) return true;
    if (Date.now() >= until) return false;   // ms=0 → ровно одна проверка, без ожидания
    await new Promise((ok) => setTimeout(ok, 400));
  }
}

function open(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  // нет графической сессии или команды — не беда, ссылка напечатана выше.
  // Ошибка spawn прилетает событием, а не исключением, поэтому и try, и .on("error").
  try {
    const p = spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    p.on("error", () => {});
    p.unref();
  } catch { /* см. выше */ }
}
