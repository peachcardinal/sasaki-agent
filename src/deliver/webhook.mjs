// Доставка вебхуком: Slack / Discord / ntfy.sh (пуш на телефон без регистрации).
// delivery.webhook: { "url": "...", "format": "slack" | "discord" | "text" }
//   slack   -> POST {"text": "..."}      (Slack incoming webhook)
//   discord -> POST {"content": "..."}   (Discord webhook)
//   text    -> POST тело как есть        (ntfy.sh/<топик> и любые простые хуки)
import { buildDigest } from "../lib/digest.mjs";

export default {
  name: "webhook",
  async deliver({ items, errors }, cfg) {
    const { url, format = "slack" } = cfg.delivery?.webhook || {};
    if (!url) throw new Error("не настроен (config → delivery.webhook.url)");
    const text = buildDigest(items, errors).md;
    const req =
      format === "text"
        ? { headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text }
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(format === "discord" ? { content: text.slice(0, 1900) } : { text }),
          };
    const res = await fetch(url, { method: "POST", ...req });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
};
