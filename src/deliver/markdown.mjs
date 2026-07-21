// Доставка markdown-файлами в папку. Укажи путь внутрь Obsidian vault —
// получишь вакансии прямо в заметках. delivery.markdown.dir, дефолт out/.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { projectRoot } from "../lib/env.mjs";
import { buildDigest, stamp } from "../lib/digest.mjs";

export default {
  name: "markdown",
  async deliver({ items, errors }, cfg) {
    const dir = cfg.delivery?.markdown?.dir || "out";
    const abs = isAbsolute(dir) ? dir : join(projectRoot, dir);
    mkdirSync(abs, { recursive: true });
    const file = join(abs, `vacancies-${stamp()}.md`);
    writeFileSync(file, buildDigest(items, errors).md);
    console.log(`[markdown] ${file}`);
  },
};
