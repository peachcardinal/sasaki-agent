#!/usr/bin/env node
// Помощник: узнать chat_id. Сначала напиши боту любое сообщение, потом запусти это.
import { loadEnv } from "./lib/env.mjs";

loadEnv();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Сначала добавь TELEGRAM_BOT_TOKEN в .env (токен выдаёт @BotFather).");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const json = await res.json();
if (!json.ok) {
  console.error(`Ошибка Telegram: ${json.description}`);
  process.exit(1);
}
const chats = new Map();
for (const u of json.result) {
  const chat = u.message?.chat || u.channel_post?.chat;
  if (chat) chats.set(chat.id, chat.username || chat.title || chat.first_name || "");
}
if (chats.size === 0) {
  console.log("Обновлений нет. Напиши своему боту любое сообщение и запусти снова.");
} else {
  console.log("Найденные чаты — добавь нужный id в .env как TELEGRAM_CHAT_ID:");
  for (const [id, name] of chats) console.log(`  TELEGRAM_CHAT_ID=${id}   # ${name}`);
}
