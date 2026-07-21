// Доставка в Telegram-бота (настройка: npm run setup, раздел «Доставка»).
import { sendTelegram, telegramConfigured } from "../lib/telegram.mjs";
import { buildDigest } from "../lib/digest.mjs";

export default {
  name: "telegram",
  async deliver({ items, errors }) {
    if (!telegramConfigured()) {
      throw new Error("не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID в .env)");
    }
    await sendTelegram(buildDigest(items, errors).html);
  },
};
