# Источники: как устроены и как добавить свой

## Архитектура

Источник — один `.mjs`-файл, который возвращает массив вакансий:

```js
export async function fetchFoo(cfg) {
  return [{ source: "foo", id: "1", title: "…", company: "…", url: "…",
            salary: "", location: "", published: "" }];
}
export default { name: "foo", fetch: fetchFoo };
```

Папки сканируются автоматически:

- `src/sources/` — все источники из коробки (в гите), см. таблицу ниже;
- `sources.local/` — твои личные адаптеры (в гит не попадают). Имя перекрывает
  ядро: файл с `name: "habr"` здесь заменит собой ядровый.

Вкл/выкл — `config.json` → `sources` (`"foo": false`); неупомянутые включены.
Параметры источника (слаги фильтров, id направлений) — в `config.json` под его
именем. Если источник фильтрует сам — ставь элементам `prefiltered: true`,
иначе их отфильтрует центральный фильтр по `title`.

## Добавить свой сайт агентом

Открой папку проекта в Claude Code и скажи:

```
/add-source https://careers.example.com/vacancies
```

Агент найдёт, как сайт отдаёт данные (API / RSS / SSR-HTML / AJAX — методика в
[.claude/skills/add-source/SKILL.md](../.claude/skills/add-source/SKILL.md)),
напишет адаптер в `sources.local/`, протестирует на живых данных и подключит.

## Что в коробке

Агрегаторы и доски — дают основной объём:

| Адаптер | Источник | Паттерн |
|---|---|---|
| hirehi.mjs | hirehi.ru | JSON API, фильтры level/format на стороне API |
| designer.mjs | designer.ru | SSR-HTML (Bitrix), грейд с карточки вакансии |
| finder.mjs | finder.vc | JSON API |
| getmatch.mjs | getmatch.ru | JSON API |
| habr.mjs | Хабр Карьера | SSR-HTML |
| telegram.mjs | публичные каналы | веб-лента `t.me/s/`, без аккаунта и ключей |
| linkedin.mjs | LinkedIn | гостевой эндпоинт job-постингов, без логина |
| hh.mjs | hh.ru | официальный API, нужен бесплатный токен |

Карьерные сайты компаний:

| Адаптер | Компания | Паттерн |
|---|---|---|
| yandex.mjs | Яндекс | открытый JSON API, курсорная пагинация |
| alfa.mjs | Альфа-Банк | открытый JSON API, take/skip |
| tochka.mjs | Точка | JSON API (категорию не задаём — их таксономия без «design») |
| rwb.mjs | Wildberries | JSON API, фильтр direction_ids[] |
| gis2.mjs | 2ГИС | JSON, вшитый в SSR-HTML |
| avito.mjs | Авито | Bitrix AJAX (X-Requested-With) |
| tbank.mjs | Т-Банк | внутренний POST API (найден перехватом) |
| vk.mjs | VK | JSON API |
| x5.mjs | X5 Group | JSON API |
| mts.mjs | МТС | JSON API |
| magnit.mjs | Магнит | JSON API |

Сетевые сбои источника пайплайн переживает сам: ошибки вида
`fetch failed` / таймаут / HTTP 5xx повторяются до трёх раз, а ошибки настройки
(нет токена) — нет, они детерминированные.

## Известные тупики

Сайты за серьёзными бот-протекшенами прямым адаптером не берутся — и не надо:
почти все компании дублируют вакансии на hh.ru, его и используй (нужен токен,
см. [setup.md](setup.md)). Проверенные примеры: Сбер (SSR-only за F5),
Контур (редирект-петля), Озон (JS-челлендж; их вакансии несут `hhId`).
