#!/usr/bin/env python3
"""Сканер телеграм-каналов для sasaki-agent — тупой фетчер, ничего не решает.

Читает каналы, на которые подписан ТВОЙ аккаунт, через официальный
MTProto-API (Telethon) и отдаёт новые посты JSON'ом в stdout. По каждому
каналу ведёт курсор последнего сообщения в state-файле, чтобы не качать
одно и то же. Фильтрация — на стороне collect.mjs.

Запуск через uv (telethon в изолированном окружении, в систему не ставится):

    uv run --with telethon python src/telegram/tg_fetch.py login   # разово
    uv run --with telethon python src/telegram/tg_fetch.py list    # мои каналы
    uv run --with telethon python src/telegram/tg_fetch.py scan \
        --channel @kanal --state data/tg-cursors.json

TG_API_ID / TG_API_HASH — из .env проекта или переменных окружения
(получить: https://my.telegram.org -> API development tools, бесплатно).
Сессия: data/tg.session (в гите игнорируется).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import os
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SESSION = str(ROOT / "data" / "tg")


def err(*args):
    print(*args, file=sys.stderr)


def load_env():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip("\"'")
        os.environ.setdefault(key, val)


def client():
    from telethon.sync import TelegramClient

    load_env()
    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    if not api_id or not api_hash:
        err("Нет TG_API_ID / TG_API_HASH в .env — получить на my.telegram.org (API development tools).")
        sys.exit(2)
    (ROOT / "data").mkdir(exist_ok=True)
    return TelegramClient(SESSION, int(api_id), api_hash)


def normalize_ref(ref: str):
    """@handle / t.me/... / инвайт-ссылка / числовой id -> форма для Telethon."""
    ref = ref.strip()
    for p in ("tg://", "https://", "http://"):
        if ref.startswith(p):
            ref = ref[len(p):]
    ref = ref.replace("t.me/", "").replace("telegram.me/", "").strip("/")
    if ref.lstrip("-").isdigit():
        return int(ref)
    if ref.startswith("+") or ref.startswith("joinchat/"):
        return "https://t.me/" + ref
    return ref


def peer_id(entity):
    from telethon import utils

    try:
        return utils.get_peer_id(entity)
    except Exception:
        return getattr(entity, "id", None)


def permalink(entity, msg_id: int) -> str:
    username = getattr(entity, "username", None)
    if username:
        return f"https://t.me/{username}/{msg_id}"
    pid = str(peer_id(entity) or "")
    pid = pid[4:] if pid.startswith("-100") else pid.lstrip("-")
    return f"https://t.me/c/{pid}/{msg_id}" if pid else ""


def message_urls(msg) -> list[str]:
    urls = []
    for ent, val in (msg.get_entities_text() or []):
        name = type(ent).__name__
        if name == "MessageEntityTextUrl" and getattr(ent, "url", None):
            urls.append(ent.url)
        elif name == "MessageEntityUrl":
            urls.append(val)
    # ссылка «Откликнуться» часто живёт в inline-кнопке, а не в тексте
    for row in getattr(getattr(msg, "reply_markup", None), "rows", None) or []:
        for btn in getattr(row, "buttons", None) or []:
            if getattr(btn, "url", None):
                urls.append(btn.url)
    return list(dict.fromkeys(urls))


def cmd_login(_):
    with client() as c:
        me = c.get_me()
        err(f"Вошли как @{getattr(me, 'username', None) or me.first_name}. Сессия: {SESSION}.session")
    return 0


def cmd_list(_):
    with client() as c:
        rows = []
        for d in c.iter_dialogs():
            if not (d.is_channel or d.is_group):
                continue
            username = getattr(d.entity, "username", None)
            pid = peer_id(d.entity)
            rows.append({
                "title": d.name,
                "ref": f"@{username}" if username else str(pid),  # готово для config.json
                "private": username is None,
            })
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=1)
        print()
    return 0


def cmd_chatlist(args):
    """Развернуть папку-инвайт (t.me/addlist/<slug>) в список каналов.
    С --join аккаунт вступает в них (иначе сканер не сможет их читать)."""
    from telethon.tl import functions, types

    slug = args.slug.strip().rsplit("/", 1)[-1]
    with client() as c:
        info = c(functions.chatlists.CheckChatlistInviteRequest(slug=slug))
        # already_peers — уже добавленные, peers/chats — предлагаемые к добавлению
        chats = list(getattr(info, "chats", []) or [])
        rows = []
        for ch in chats:
            username = getattr(ch, "username", None)
            rows.append({
                "title": getattr(ch, "title", None),
                "ref": f"@{username}" if username else str(peer_id(ch)),
                "private": username is None,
            })
        if args.join:
            peers = [c.get_input_entity(ch) for ch in chats]
            c(functions.chatlists.JoinChatlistInviteRequest(slug=slug, peers=peers))
            eprint(f"Вступили в {len(peers)} каналов из папки.")
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=1)
        print()
    return 0


def cmd_scan(args):
    state_path = pathlib.Path(args.state)
    state: dict = {}
    if state_path.exists():
        state = json.loads(state_path.read_text())

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)
    messages, errors = [], []

    with client() as c:
        # числовые id приватных каналов резолвятся только через список диалогов
        cache = {}
        if any(isinstance(normalize_ref(ch), int) for ch in args.channel):
            for d in c.iter_dialogs():
                pid = peer_id(d.entity)
                if pid is not None:
                    cache[pid] = d.entity

        for ref in args.channel:
            norm = normalize_ref(ref)
            try:
                entity = cache.get(norm) if isinstance(norm, int) else None
                entity = entity or c.get_entity(norm)
            except Exception as exc:
                errors.append({"channel": ref, "error": f"{type(exc).__name__}: {exc}"})
                continue

            cursor = int(state.get(ref, 0))
            max_id = cursor
            if cursor:
                # идём от СТАРЫХ к новым: если постов больше лимита, обрежется
                # свежий край, и курсор не перескочит непрочитанное
                it = c.iter_messages(entity, min_id=cursor, reverse=True, limit=args.limit)
            else:
                # первый скан канала — только последние N дней, новые -> старые
                it = c.iter_messages(entity, limit=args.limit)

            count = 0
            for msg in it:
                if not cursor and msg.date and msg.date < cutoff:
                    break
                max_id = max(max_id, msg.id)
                text = msg.message or ""
                urls = message_urls(msg)
                if not text.strip() and not urls:
                    continue
                messages.append({
                    "channel_ref": ref,
                    "channel_title": getattr(entity, "title", None),
                    "msg_id": msg.id,
                    "date": msg.date.isoformat() if msg.date else None,
                    "permalink": permalink(entity, msg.id),
                    "text": text,
                    "urls": urls,
                })
                count += 1
            state[ref] = max_id
            err(f"  {ref}: новых постов {count}")

    state_path.parent.mkdir(exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    json.dump({"messages": messages, "errors": errors}, sys.stdout, ensure_ascii=False)
    print()
    return 1 if errors and not messages else 0


def main():
    p = argparse.ArgumentParser(description="Телеграм-фетчер sasaki-agent")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login")
    sub.add_parser("list")
    cl = sub.add_parser("chatlist", help="развернуть папку-инвайт t.me/addlist/<slug> в каналы")
    cl.add_argument("slug", help="slug или полная ссылка t.me/addlist/<slug>")
    cl.add_argument("--join", action="store_true", help="вступить в каналы папки")
    scan = sub.add_parser("scan")
    scan.add_argument("--channel", action="append", required=True)
    scan.add_argument("--state", default=str(ROOT / "data" / "tg-cursors.json"))
    scan.add_argument("--days", type=int, default=3, help="глубина первого скана канала")
    scan.add_argument("--limit", type=int, default=300, help="постов за прогон на канал")
    args = p.parse_args()
    return {"login": cmd_login, "list": cmd_list, "chatlist": cmd_chatlist, "scan": cmd_scan}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
