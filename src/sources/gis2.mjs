// 2ГИС: вакансии вшиты в SSR-HTML страницы как escaped-JSON ("items":[...]).
const PAGE_URL = "https://job.2gis.ru/vacancies";

export async function fetch2gis(cfg) {
  const directions = cfg["2gis"]?.directions || ["design"];
  const byId = new Map();
  for (const dir of directions) {
    const res = await fetch(`${PAGE_URL}?direction=${encodeURIComponent(dir)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) sasaki-agent/0.1" },
    });
    // 451 — гео-блок (страница «Возможно, у вас включен VPN»): сайт отвечает
    // только с российских IP; с VPN/из-за рубежа вакансии не получить
    if (res.status === 451) throw new Error("2ГИС HTTP 451: гео-блок, нужен российский IP (выключи VPN)");
    if (!res.ok) throw new Error(`2ГИС HTTP ${res.status}`);
    const html = (await res.text()).replaceAll('\\"', '"');
    const start = html.indexOf('"items":[{"id":');
    if (start === -1) continue;
    // элементы идут подряд; режем по границам объектов
    const blob = html.slice(start, html.indexOf("]", start + 500) + 1 || undefined);
    for (const chunk of blob.split('},{"id":')) {
      const id = (chunk.match(/(?:"id":)?(\d+),"title"/) || [])[1];
      const title = (chunk.match(/"title":"((?:[^"\\]|\\.)*)"/) || [])[1];
      if (!id || !title) continue;
      const remote = /"isRemote":true/.test(chunk);
      const city = (chunk.match(/"city":\{[^}]*"name":"([^"]+)"/) || [])[1] || "";
      const from = (chunk.match(/"salaryFrom":(\d+)/) || [])[1];
      const to = (chunk.match(/"salaryTo":(\d+)/) || [])[1];
      const k = (n) => Math.round(n / 1000) + "k";
      byId.set(id, {
        source: "2gis",
        id,
        title: title.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
        company: "2ГИС",
        url: `https://job.2gis.ru/vacancies/${id}`,
        salary: from && to ? `${k(+from)}–${k(+to)} ₽` : from ? `от ${k(+from)} ₽` : to ? `до ${k(+to)} ₽` : "",
        location: [city, remote ? "удалённо" : ""].filter(Boolean).join(" · "),
        published: "",
      });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...byId.values()];
}

export default { name: "2gis", fetch: fetch2gis };
