// Сборка дайджеста из найденных вакансий — HTML (Telegram) и Markdown.
import { escapeHtml } from "./telegram.mjs";

// Ссылки только http/https: содержимое источников не доверенное, javascript:
// и прочие схемы в кликабельные ссылки не превращаем.
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

export function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

export function buildDigest(items, errors = []) {
  const date = new Date().toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const bySource = Map.groupBy(items, (v) => v.source);
  let html = `🔎 <b>Новые вакансии: ${items.length}</b> · ${date}\n`;
  let md = `# Новые вакансии: ${items.length} · ${date}\n`;
  for (const [source, list] of bySource) {
    html += `\n<b>${source}</b>\n`;
    md += `\n## ${source}\n`;
    for (const v of list) {
      const meta = [v.salary, v.location].filter(Boolean).join(" · ");
      const url = safeUrl(v.url);
      // ссылка-отклик показывается, только если она ведёт наружу (не дубль основной)
      const apply = v.applyUrl && v.applyUrl !== v.url ? safeUrl(v.applyUrl) : "";
      html += `• ${url ? `<a href="${url}">${escapeHtml(v.title)}</a>` : escapeHtml(v.title)}${v.company ? ` — ${escapeHtml(v.company)}` : ""}${meta ? ` · ${escapeHtml(meta)}` : ""}${apply ? ` · <a href="${apply}">↗ отклик</a>` : ""}\n`;
      md += `- ${url ? `[${v.title}](${url})` : v.title}${v.company ? ` — ${v.company}` : ""}${meta ? ` · ${meta}` : ""}${apply ? ` · [↗ отклик](${apply})` : ""}\n`;
    }
  }
  if (errors.length) {
    html += `\n⚠️ Сбои: ${errors.map(escapeHtml).join("; ")}`;
    md += `\n> ⚠️ Сбои: ${errors.join("; ")}\n`;
  }
  return { html, md };
}
