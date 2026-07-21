import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

// Минимальный загрузчик .env — без зависимостей.
export function loadEnv() {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env нет — работаем на том, что есть в окружении
  }
}
