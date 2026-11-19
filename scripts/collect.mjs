// Recolecta batallas ranked de los mejores jugadores globales y calcula estadísticas.
// Usa el proxy de RoyaleAPI. La key viene del secreto BRAWL_API_KEY.

import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://bsproxy.royaleapi.dev/v1";
const KEY = process.env.BRAWL_API_KEY;
const TOP = Math.min(Number(process.env.TOP_PLAYERS || 200), 200);
const DELAY_MS = Number(process.env.DELAY_MS || 300);
const RANKED_TYPES = new Set(["soloRanked", "ranked"]);

if (!KEY) {
  console.error("Falta BRAWL_API_KEY");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} en ${path}`);
  }
  throw new Error(`Reintentos agotados en ${path}`);
}

const ranking = await api(`/rankings/global/players?limit=${TOP}`);
const players = ranking.items || [];
console.log(`Jugadores en la muestra: ${players.length}`);

const seen = new Set();
const maps = {}; // clave: modo|mapa
let totalBattles = 0;
let failed = 0;

for (const p of players) {
  let log;
  try {
    log = await api(`/players/${encodeURIComponent(p.tag)}/battlelog`);
  } catch (e) {
    failed++;
    console.warn(`Saltado ${p.tag}: ${e.message}`);
    await sleep(DELAY_MS);
    continue;
  }

  for (const it of log.items || []) {
    const b = it.battle;
    if (!b || !RANKED_TYPES.has(b.type) || !b.teams) continue;
    if (b.result !== "victory" && b.result !== "defeat") continue;

    const allTags = b.teams.flat().map((x) => x.tag).sort();
    const key = `${it.battleTime}|${allTags.join(",")}`;
    if (seen.has(key)) continue; // la misma partida sale en el historial de sus 6 jugadores
    seen.add(key);

    // El resultado es del jugador dueño del historial: buscamos su equipo.
    const myTeamIdx = b.teams.findIndex((t) => t.some((x) => x.tag === p.tag));
    if (myTeamIdx === -1) continue;
    const winnerIdx = b.result === "victory" ? myTeamIdx : 1 - myTeamIdx;

    const mode = it.event?.mode || b.mode || "unknown";
    const map = it.event?.map || "unknown";
    const mk = `${mode}|${map}`;
    maps[mk] ??= { mode, map, battles: 0, brawlers: {} };
    maps[mk].battles++;
    totalBattles++;

    b.teams.forEach((team, idx) => {
      for (const pl of team) {
        const id = pl.brawler?.id;
        if (!id) continue;
        const r = (maps[mk].brawlers[id] ??= { id, name: pl.brawler.name, picks: 0, wins: 0 });
        r.picks++;
        if (idx === winnerIdx) r.wins++;
      }
    });
  }
  await sleep(DELAY_MS);
}

const out = {
  generatedAt: new Date().toISOString(),
  sample: { players: players.length, failedPlayers: failed, rankedBattles: totalBattles },
  maps: Object.values(maps).map((m) => ({
    ...m,
    brawlers: Object.values(m.brawlers).sort((a, b) => b.picks - a.picks),
  })),
};

mkdirSync("data", { recursive: true });
writeFileSync("data/stats.json", JSON.stringify(out));
console.log(`Listo: ${totalBattles} batallas ranked únicas, ${out.maps.length} mapas.`);
