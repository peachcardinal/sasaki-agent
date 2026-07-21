// Автозапуск: два фоновых агента, чтобы человеку не приходилось ничего
// запускать руками.
//   collect — сборщик, раз в 6 часов;
//   ui      — пульт, висит всегда (KeepAlive поднимет после падения и логина).
//
// Пульт под супервизором сам выходит при изменении кода в src/ (см. server.mjs):
// ES-модули кешируются в процессе, и после git pull старый процесс продолжал бы
// отдавать прежнюю версию. Вышел → launchd поднял с новым кодом.
//
// macOS — launchd (полноценно). Linux — печатаем строки для crontab/systemd.
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { projectRoot } from "./env.mjs";

export const UI_PORT = Number(process.env.PORT) || 4321;

// Историческое имя сборщика не меняем: у тех, кто уже ставил, иначе появится дубль.
export const SERVICES = {
  collect: { label: "com.sasaki-agent", title: "сборщик (раз в 6 ч)" },
  ui: { label: "com.sasaki-agent.ui", title: `пульт (http://127.0.0.1:${UI_PORT})` },
};

const plistPath = (label) => join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function wrap(label, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>WorkingDirectory</key><string>${xmlEscape(projectRoot)}</string>
${inner}
</dict>
</plist>
`;
}

function collectPlist(label) {
  return wrap(label, `  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(join(projectRoot, "src/collect.mjs"))}</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(projectRoot, "logs/collect.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(projectRoot, "logs/collect.log"))}</string>`);
}

function uiPlist(label) {
  return wrap(label, `  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(join(projectRoot, "src/server.mjs"))}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>${UI_PORT}</string>
    <key>SASAKI_SUPERVISED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(join(projectRoot, "logs/ui.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(projectRoot, "logs/ui.log"))}</string>`);
}

const BUILDERS = { collect: collectPlist, ui: uiPlist };

export function install(kind) {
  const { label } = SERVICES[kind];
  const path = plistPath(label);
  mkdirSync(join(projectRoot, "logs"), { recursive: true });
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(path, BUILDERS[kind](label));
  try { execSync(`launchctl unload ${JSON.stringify(path)} 2>/dev/null`); } catch { /* не был загружен */ }
  execSync(`launchctl load ${JSON.stringify(path)}`);
  return path;
}

export function uninstall(kind) {
  const { label } = SERVICES[kind];
  const path = plistPath(label);
  try { execSync(`launchctl unload ${JSON.stringify(path)} 2>/dev/null`); } catch { /* уже выгружен */ }
  if (existsSync(path)) unlinkSync(path);
  return path;
}

// Загружен ли агент и жив ли процесс (PID в выводе launchctl list).
export function status(kind) {
  const { label } = SERVICES[kind];
  const out = { label, installed: existsSync(plistPath(label)), loaded: false, pid: null };
  try {
    // launchctl list: «PID Status Label». Сравниваем ЛЕЙБЛ ЦЕЛИКОМ: "com.sasaki-agent"
    // — префикс "com.sasaki-agent.ui", и подстрочный поиск путал бы их между собой.
    const out2 = execSync("launchctl list", { encoding: "utf8" });
    const line = out2.split("\n").find((l) => l.split(/\s+/)[2] === label);
    if (line) {
      out.loaded = true;
      const pid = line.split(/\s+/)[0];
      out.pid = pid === "-" ? null : Number(pid);
    }
  } catch { /* launchctl недоступен */ }
  return out;
}

// Отвечает ли пульт по HTTP — главный признак «работает», а не просто «загружен».
export async function uiResponds() {
  try {
    const res = await fetch(`http://127.0.0.1:${UI_PORT}/api/state`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function linuxHints() {
  return [
    "Сборщик — в crontab (crontab -e):",
    `  0 */6 * * * cd ${projectRoot} && ${process.execPath} src/collect.mjs >> logs/collect.log 2>&1`,
    "",
    "Пульт — systemd-юнит пользователя (~/.config/systemd/user/sasaki-ui.service):",
    "  [Unit]",
    "  Description=sasaki-agent · пульт",
    "  [Service]",
    `  WorkingDirectory=${projectRoot}`,
    `  ExecStart=${process.execPath} src/server.mjs`,
    `  Environment=PORT=${UI_PORT} SASAKI_SUPERVISED=1`,
    "  Restart=always",
    "  [Install]",
    "  WantedBy=default.target",
    "",
    "  systemctl --user enable --now sasaki-ui",
  ].join("\n");
}
