#!/usr/bin/env node
// Прогон по расписанию: собрать → отфильтровать → отсеять виденное → доставить.
// Вся логика — в src/lib/run.mjs (её же использует UI-сервер).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, projectRoot } from "./lib/env.mjs";
import { runPipeline } from "./lib/run.mjs";

loadEnv();
let cfg;
try {
  cfg = JSON.parse(readFileSync(join(projectRoot, "config.json"), "utf8"));
} catch {
  console.error("Нет config.json — сначала запусти мастер настройки: npm run setup");
  process.exit(1);
}

await runPipeline(cfg);
