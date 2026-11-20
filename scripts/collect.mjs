// Recolecta batallas de los mejores jugadores globales y las ACUMULA entre ejecuciones
// (ventana móvil). Usa el proxy de RoyaleAPI. La key viene del secreto BRAWL_API_KEY.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE = "https://bsproxy.royaleapi.dev/v1";
const KEY = process.env.BRAWL_API_KEY;
const TOP = Math.min(Number(process.env.TOP_PLAYERS || 200), 200);
const DELAY_MS = Number(process.env.DELAY_MS || 300);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const RANKED_TYPES = new Set(["soloRanked", "ranked"]);
const MODES = new Set(["gemGrab", "brawlBall", "knockout", "bounty", "hotZone", "heist"]);
const STATE_PATH = "data/state.json";
const MIN_PAIR_GAMES = Number(process.env.MIN_PAIR_GAMES || 2); // pares con menos partidas no se publican en stats.json

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

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    console.warn("No se pudo leer state.json, se empieza de cero:", e.message);
    return {};
  }
}

const state = loadState();
state.seen ??= {}; // hash de batalla -> día (YYYY-MM-DD)
state.days ??= {}; // día -> "modo|mapa" -> { mode, map, battles, b: { idBrawler: [picks, wins] } }
state.names ??= {}; // idBrawler -> nombre
state.pairs ??= {}; // día -> modo -> { s: {"idA-idB": [partidas, victorias]} (aliados), v: {"idC>idE": [partidas, victorias de C]} (C contra E) }

// Quita lo que salió de la ventana de días.
const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
for (const k of Object.keys(state.seen)) if (state.seen[k] < cutoff) delete state.seen[k];
for (const d of Object.keys(state.days)) if (d < cutoff) delete state.days[d];
for (const d of Object.keys(state.pairs)) if (d < cutoff) delete state.pairs[d];

const ranking = await api(`/rankings/global/players?limit=${TOP}`);
const players = ranking.items || [];
console.log(`Jugadores en la muestra: ${players.length}`);

let newBattles = 0;
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

    const mode = it.event?.mode || b.mode || "unknown";
    const map = it.event?.map || "unknown";
    if (!MODES.has(mode) || map === "unknown") continue;

    const everyone = b.teams.flat();
    // Descarta eventos donde todos juegan el mismo brawler.
    if (new Set(everyone.map((x) => x.brawler?.id)).size === 1) continue;

    const t = it.battleTime;
    const day = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    if (day < cutoff) continue;

    // La misma partida sale en el historial de sus 6 jugadores: se cuenta una sola vez.
    const allTags = everyone.map((x) => x.tag).sort();
    const hash = createHash("sha1").update(`${t}|${allTags.join(",")}`).digest("hex").slice(0, 12);
    if (state.seen[hash]) continue;

    // El resultado es del jugador dueño del historial: buscamos su equipo.
    const myTeamIdx = b.teams.findIndex((team) => team.some((x) => x.tag === p.tag));
    if (myTeamIdx === -1) continue;
    const winnerIdx = b.result === "victory" ? myTeamIdx : 1 - myTeamIdx;

    state.seen[hash] = day;
    const mk = `${mode}|${map}`;
    const bucket = ((state.days[day] ??= {})[mk] ??= { mode, map, battles: 0, b: {} });
    bucket.battles++;
    newBattles++;

    b.teams.forEach((team, idx) => {
      for (const pl of team) {
        const id = pl.brawler?.id;
        if (!id) continue;
        state.names[id] = pl.brawler.name;
        const r = (bucket.b[id] ??= [0, 0]);
        r[0]++;
        if (idx === winnerIdx) r[1]++;
      }
    });

    // Pares: sinergias (mismo equipo) y enfrentamientos (equipos rivales), por modo.
    const pb = (((state.pairs[day] ??= {})[mode]) ??= { s: {}, v: {} });
    b.teams.forEach((team, idx) => {
      const won = idx === winnerIdx ? 1 : 0;
      const mine = team.map((x) => x.brawler?.id).filter(Boolean);
      const foes = (b.teams[1 - idx] || []).map((x) => x.brawler?.id).filter(Boolean);
      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          if (mine[i] === mine[j]) continue;
          const k = mine[i] < mine[j] ? `${mine[i]}-${mine[j]}` : `${mine[j]}-${mine[i]}`;
          const r = (pb.s[k] ??= [0, 0]);
          r[0]++;
          r[1] += won;
        }
      }
      for (const c of mine) {
        for (const e of foes) {
          if (c === e) continue;
          const r = (pb.v[`${c}>${e}`] ??= [0, 0]);
          r[0]++;
          r[1] += won;
        }
      }
    });
  }
  await sleep(DELAY_MS);
}

// Suma todos los días de la ventana.
const merged = {};
for (const dayData of Object.values(state.days)) {
  for (const [mk, m] of Object.entries(dayData)) {
    const tot = (merged[mk] ??= { mode: m.mode, map: m.map, battles: 0, brawlers: {} });
    tot.battles += m.battles;
    for (const [id, [picks, wins]] of Object.entries(m.b)) {
      const r = (tot.brawlers[id] ??= { id: Number(id), name: state.names[id] || id, picks: 0, wins: 0 });
      r.picks += picks;
      r.wins += wins;
    }
  }
}

const maps = Object.values(merged).map((m) => ({
  ...m,
  brawlers: Object.values(m.brawlers).sort((a, b) => b.picks - a.picks),
}));
const totalBattles = maps.reduce((s, m) => s + m.battles, 0);

// Suma los pares de todos los días de la ventana y publica solo los que tienen datos suficientes.
const mergedPairs = {};
for (const dayData of Object.values(state.pairs)) {
  for (const [mode, pb] of Object.entries(dayData)) {
    const t = (mergedPairs[mode] ??= { s: {}, v: {} });
    for (const kind of ["s", "v"]) {
      for (const [k, [g, w]] of Object.entries(pb[kind])) {
        const r = (t[kind][k] ??= [0, 0]);
        r[0] += g;
        r[1] += w;
      }
    }
  }
}
const pairs = {};
for (const [mode, t] of Object.entries(mergedPairs)) {
  const out = (obj, sep) =>
    Object.entries(obj)
      .filter(([, [g]]) => g >= MIN_PAIR_GAMES)
      .map(([k, [g, w]]) => {
        const [x, y] = k.split(sep);
        return [Number(x), Number(y), g, w];
      });
  // syn: [idA, idB, partidas, victorias] (idA < idB) · vs: [idC, idE, partidas, victorias de C]
  pairs[mode] = { syn: out(t.s, "-"), vs: out(t.v, ">") };
}

const out = {
  generatedAt: new Date().toISOString(),
  sample: {
    players: players.length,
    failedPlayers: failed,
    windowDays: WINDOW_DAYS,
    newBattles,
    rankedBattles: totalBattles,
    pairMinGames: MIN_PAIR_GAMES,
  },
  maps,
  pairs,
};

mkdirSync("data", { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify(state));
writeFileSync("data/stats.json", JSON.stringify(out));
console.log(`Listo: ${newBattles} batallas nuevas, ${totalBattles} en la ventana, ${maps.length} mapas.`);
