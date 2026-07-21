// Доставка в CSV-таблицу (трекер откликов): строка на вакансию, дописывается.
// Открывается в Excel/Numbers, импортируется в Google Sheets.
// delivery.csv.file, дефолт out/vacancies.csv.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { projectRoot } from "../lib/env.mjs";

const HEADER = "дата,источник,вакансия,компания,зарплата,локация,ссылка,статус\n";

export default {
  name: "csv",
  async deliver({ items }, cfg) {
    const file = cfg.delivery?.csv?.file || "out/vacancies.csv";
    const abs = isAbsolute(file) ? file : join(projectRoot, file);
    mkdirSync(dirname(abs), { recursive: true });
    const isNew = !existsSync(abs);
    const date = new Date().toISOString().slice(0, 10);
    const rows = items
      .map((v) =>
        [date, v.source, v.title, v.company, v.salary, v.location, v.url, ""]
          .map(csvEscape)
          .join(",")
      )
      .join("\n");
    appendFileSync(abs, (isNew ? "﻿" + HEADER : "") + rows + "\n");
    console.log(`[csv] +${items.length} строк в ${abs}`);
  },
};

function csvEscape(v) {
  let s = String(v ?? "");
  // ведущие =+-@ и таб Excel/Sheets трактуют как формулу — нейтрализуем апострофом
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
