#!/usr/bin/env node
// Управление автозапуском: npm run service [status|install|uninstall]
// Без аргумента — status. Смысл: пульт всегда доступен на localhost, сборщик
// ходит по расписанию, руками запускать ничего не нужно.
import { install, uninstall, status, uiResponds, linuxHints, SERVICES, UI_PORT } from "./lib/service.mjs";

const cmd = process.argv[2] || "status";

if (process.platform !== "darwin") {
  console.log("Автоустановка есть только для macOS (launchd). Для Linux:\n");
  console.log(linuxHints());
  process.exit(0);
}

if (cmd === "install") {
  for (const kind of ["collect", "ui"]) {
    const path = install(kind);
    console.log(`✓ ${SERVICES[kind].title}\n  ${path}`);
  }
  console.log("\nЖдём, пока пульт поднимется…");
  const ok = await waitForUi();
  console.log(ok ? `✓ Пульт отвечает: http://127.0.0.1:${UI_PORT}` : "⚠ Пульт пока не отвечает — смотри logs/ui.log");
  console.log("\nТеперь пульт стартует сам при входе в систему и переживает перезагрузку.");
} else if (cmd === "uninstall") {
  for (const kind of ["collect", "ui"]) {
    uninstall(kind);
    console.log(`✓ снят: ${SERVICES[kind].title}`);
  }
} else {
  await printStatus();
}

async function waitForUi(tries = 10) {
  for (let i = 0; i < tries; i++) {
    if (await uiResponds()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function printStatus() {
  console.log("Автозапуск sasaki-agent\n");
  for (const kind of ["collect", "ui"]) {
    const s = status(kind);
    const mark = s.loaded ? "✓" : s.installed ? "•" : "×";
    const state = !s.installed ? "не установлен"
      : !s.loaded ? "установлен, но не загружен"
      : s.pid ? `работает (pid ${s.pid})` : "загружен, ждёт запуска по расписанию";
    console.log(`${mark} ${SERVICES[kind].title.padEnd(34)} ${state}`);
  }
  const alive = await uiResponds();
  console.log(`\n${alive ? "✓" : "×"} HTTP-проверка пульта: ${alive ? "отвечает" : "не отвечает"} на http://127.0.0.1:${UI_PORT}`);
  if (!status("ui").installed) console.log("\nПоставить автозапуск: npm run service install");
}
