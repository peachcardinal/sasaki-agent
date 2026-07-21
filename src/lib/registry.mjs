// Автодискавери плагинов: источники и каналы доставки — просто файлы в папках.
// Источник:  export default { name, fetch(cfg) -> [{source,id,title,company,url,...}] }
// Доставка:  export default { name, deliver({items, errors}, cfg) }
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./env.mjs";

async function loadDir(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (mod.default?.name) out.push(mod.default);
  }
  return out;
}

// src/sources — ядро (в гите), sources.local — личные адаптеры (не в гите)
export async function discoverSources() {
  const all = [
    ...(await loadDir(join(projectRoot, "src/sources"))),
    ...(await loadDir(join(projectRoot, "sources.local"))),
  ];
  const byName = new Map();
  for (const s of all) byName.set(s.name, s); // sources.local перекрывает ядро
  return [...byName.values()];
}

export async function discoverDeliverers() {
  return loadDir(join(projectRoot, "src/deliver"));
}
