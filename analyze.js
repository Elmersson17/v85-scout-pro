const fetch = require('node-fetch');

// ─── ATG API ENDPOINTS ───
const ATG_BASE = 'https://www.atg.se/services/racinginfo/v1/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; V85ScoutPro/1.0)',
  'Accept': 'application/json',
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  try {
    const raw = (event.queryStringParameters?.game || '').trim();
    if (!raw) {
      return res(400, { error: 'Ange ett spel-ID, t.ex. V85_2026-03-09_1' }, cors);
    }

    // ── Parse game ID ──
    const gameId = parseGameId(raw);
    if (!gameId) {
      return res(400, { error: `Kunde inte tolka spel-ID: "${raw}". Format: V85_YYYY-MM-DD_N` }, cors);
    }

    console.log(`[V85] Fetching game: ${gameId}`);

    // ── 1. Hämta spelinfo ──
    const gameData = await fetchJSON(`${ATG_BASE}/games/${gameId}`);
    if (!gameData || !gameData.races) {
      return res(404, { error: `Hittade inget spel: ${gameId}` }, cors);
    }

    // ── 2. Hämta varje lopp parallellt ──
    const raceIds = gameData.races.map(r => r.id);
    const raceDetails = await Promise.all(
      raceIds.map(id => fetchJSON(`${ATG_BASE}/races/${id}`).catch(() => null))
    );

    // ── 3. Bearbeta alla lopp ──
    const races = raceDetails
      .filter(Boolean)
      .map(race => processRace(race, gameData));

    // ── 4. Returnera ──
    const result = {
      gameId,
      track: gameData.tracks?.[0]?.name || races[0]?.track || '–',
      date: gameId.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '',
      races,
      fetchedAt: new Date().toISOString(),
    };

    return res(200, result, cors);

  } catch (err) {
    console.error('[V85] Error:', err);
    return res(500, { error: `Serverfel: ${err.message}` }, cors);
  }
};

// ═══════════════════════════════════════════
// PARSE GAME ID
// ═══════════════════════════════════════════
function parseGameId(raw) {
  // Direct ID: V85_2026-03-09_1
  let m = raw.match(/^(V8[56]_\d{4}-\d{2}-\d{2}_\d+)$/i);
  if (m) return m[1].toUpperCase();

  // Partial: V85_2026-03-09_1 with spaces etc.
  m = raw.match(/V8[56][_\s\/]*(\d{4}-\d{2}-\d{2})[_\s\/]*(\d+)/i);
  if (m) return `V85_${m[1]}_${m[2]}`;

  // ATG URL: /spel/V85/2026-03-09/1 or similar
  m = raw.match(/V8[56]\/(\d{4}-\d{2}-\d{2})\/(\d+)/i);
  if (m) return `V85_${m[1]}_${m[2]}`;

  // ATG URL with game type: /services/.../games/V85_...
  m = raw.match(/(V8[56]_\d{4}-\d{2}-\d{2}_\d+)/i);
  if (m) return m[1].toUpperCase();

  return null;
}

// ═══════════════════════════════════════════
// FETCH JSON
// ═══════════════════════════════════════════
async function fetchJSON(url) {
  const r = await fetch(url, { headers: HEADERS, timeout: 12000 });
  if (!r.ok) throw new Error(`ATG ${r.status}: ${url}`);
  return r.json();
}

// ═══════════════════════════════════════════
// PROCESS RACE
// ═══════════════════════════════════════════
function processRace(race) {
  const starts = race.starts || [];
  const horses = starts.map(s => processHorse(s, race));

  // ── Beräkna insights ──
  const insights = calcInsights(horses, race);

  // ── Scout-analys (automatgenererad) ──
  const scoutAnalysis = buildScoutAnalysis(horses, insights, race);

  // ── Markera scout picks ──
  markScoutPicks(horses, insights);

  return {
    raceNumber: race.number,
    name: race.name || `Lopp ${race.number}`,
    track: race.track?.name || '–',
    distance: race.distance,
    startMethod: race.startMethod === 'auto' ? 'auto' : 'volt',
    startTime: race.startTime || race.scheduledStartTime || null,
    scoutAnalysis,
    horses,
    insights,
  };
}

// ═══════════════════════════════════════════
// PROCESS HORSE
// ═══════════════════════════════════════════
function processHorse(start, race) {
  const horse = start.horse || {};
  const driver = start.driver || {};
  const trainer = horse.trainer || start.trainer || {};
  const result = start.result || {};
  const pools = start.pools || {};

  // ── Odds ──
  const vinnare = pools.V85?.odds || pools.vinnare?.odds || null;
  const winOdds = vinnare ? (vinnare / 100) : null;

  // ── Formsträngen ──
  const formStr = buildFormString(horse);
  const recentStarts = buildRecentStarts(horse);

  // ── Km-tider ──
  const times = extractTimes(horse);

  // ── Kusk & Tränare statistik ──
  const driverStats = buildPersonStats(driver);
  const trainerStats = buildPersonStats(trainer);

  // ── Value Score ──
  const histWinPct = calcHistWinPct(horse);
  const impliedPct = winOdds ? (100 / winOdds) : 0;
  const valueScore = histWinPct - impliedPct;

  // ── Flags / Signaler ──
  const flags = buildFlags(start, horse, driver, trainer, times, formStr, valueScore);

  // ── Front Runner Score ──
  const frontRunnerScore = calcFrontRunner(start, race);

  return {
    nr: start.number,
    name: horse.name || `Häst ${start.number}`,
    driver: driverStats.name || driver.firstName + ' ' + driver.lastName || '–',
    trainer: trainerStats.name || trainer.firstName + ' ' + trainer.lastName || '–',
    winOdds,
    postPosition: start.postPosition || start.number,
    history: {
      formStr,
      avgKmTime10: times.avg,
      bestKmTime: times.best,
      timeTrend: times.trend,
      recentStarts,
      trackStats: buildTrackStats(horse, race.track?.name),
    },
    driver: {
      name: driverStats.name,
      thisYearWinPct: driverStats.yearPct,
      form30: driverStats.form30,
      form14: driverStats.form14,
      inForm: driverStats.inForm,
    },
    trainer: {
      name: trainerStats.name,
      thisYearWinPct: trainerStats.yearPct,
      form30: trainerStats.form30,
      form14: trainerStats.form14,
      inForm: trainerStats.inForm,
    },
    flags,
    valueScore: Math.round(valueScore * 10) / 10,
    frontRunnerScore,
    analysis: horse.raceComment || start.raceComment || '',
    scoutPick: false,
    scoutPickType: null,
  };
}

// ═══════════════════════════════════════════
// FORM STRING
// ═══════════════════════════════════════════
function buildFormString(horse) {
  const records = horse.records || horse.results || [];
  if (!records.length && horse.formFigures) return horse.formFigures.slice(0, 5);

  // Try to build from results
  let form = '';
  const results = (horse.startSummary?.lastStarts || horse.results || []).slice(0, 5);
  for (const r of results) {
    const place = r.place || r.finishOrder || r.galllesPosition;
    if (r.disqualified || r.dq) form += 'D';
    else if (place === 1) form += 'V';
    else if (place <= 3) form += 'P';
    else form += 'U';
  }
  return form || '–';
}

// ═══════════════════════════════════════════
// RECENT STARTS
// ═══════════════════════════════════════════
function buildRecentStarts(horse) {
  const starts = horse.startSummary?.lastStarts || horse.results || [];
  return starts.slice(0, 7).map(s => ({
    date: s.date || s.raceDate || '–',
    track: s.track?.name || s.trackName || '–',
    distance: s.distance || null,
    place: s.place || s.finishOrder || null,
    disk: s.disqualified || s.dq || false,
    kmTimeRaw: s.kmTime || s.kilometerTime || '–',
    odds: s.odds ? (s.odds / 100) : null,
    driver: s.driver?.firstName ? `${s.driver.firstName} ${s.driver.lastName}` : null,
  }));
}

// ═══════════════════════════════════════════
// KM-TIDER
// ═══════════════════════════════════════════
function extractTimes(horse) {
  const starts = horse.startSummary?.lastStarts || horse.results || [];
  const times = [];

  for (const s of starts.slice(0, 10)) {
    const raw = s.kmTime || s.kilometerTime;
    if (raw) {
      const secs = parseKmTime(raw);
      if (secs > 0) times.push(secs);
    }
  }

  if (!times.length) {
    // Try from records
    const rec = horse.records || {};
    if (rec.bestAutoTime) {
      const s = parseKmTime(rec.bestAutoTime);
      if (s > 0) return { avg: s, best: s, trend: 'stable' };
    }
    return { avg: null, best: null, trend: 'stable' };
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const best = Math.min(...times);

  // Trend: compare first half vs second half
  let trend = 'stable';
  if (times.length >= 4) {
    const half = Math.floor(times.length / 2);
    const recent = times.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const older = times.slice(half).reduce((a, b) => a + b, 0) / (times.length - half);
    if (recent < older - 0.5) trend = 'improving';
    else if (recent > older + 0.5) trend = 'declining';
  }

  return { avg: Math.round(avg * 10) / 10, best: Math.round(best * 10) / 10, trend };
}

function parseKmTime(raw) {
  if (!raw || typeof raw === 'number') return raw || 0;
  // Formats: "1.14,5" "1:14.5" "74.5"
  const str = String(raw).replace(',', '.').replace(':', '.');
  const parts = str.split('.');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseFloat('0.' + parts[2]);
  }
  if (parts.length === 2) {
    const val = parseFloat(str);
    return val > 60 ? val : val * 60; // assume minutes if < 2
  }
  return parseFloat(str) || 0;
}

// ═══════════════════════════════════════════
// PERSON STATS (kusk/tränare)
// ═══════════════════════════════════════════
function buildPersonStats(person) {
  if (!person) return { name: '–', yearPct: 0, form30: null, form14: null, inForm: false };

  const name = [person.firstName, person.lastName].filter(Boolean).join(' ') || '–';
  const stats = person.statistics || person.stats || {};

  // Try to extract win percentages from ATG data
  const yearStarts = stats.starts || stats.thisYear?.starts || 0;
  const yearWins = stats.wins || stats.thisYear?.wins || 0;
  const yearPct = yearStarts > 0 ? Math.round(yearWins / yearStarts * 100) : 0;

  // Last 30 days (ATG sometimes provides this)
  const last30 = stats.last30Days || stats.last30 || {};
  const s30 = last30.starts || Math.round(yearStarts / 12);
  const w30 = last30.wins || Math.round(yearWins / 12);
  const pct30 = s30 > 0 ? Math.round(w30 / s30 * 100) : yearPct;

  // Last 14 days (estimate)
  const s14 = Math.round(s30 / 2);
  const w14 = Math.round(w30 / 2);
  const pct14 = s14 > 0 ? Math.round(w14 / s14 * 100) : pct30;

  const inForm = pct30 >= 18;

  return {
    name,
    yearPct,
    form30: { starts: s30, wins: w30, winPct: pct30 },
    form14: { starts: s14, wins: w14, winPct: pct14 },
    inForm,
  };
}

// ═══════════════════════════════════════════
// TRACK STATS
// ═══════════════════════════════════════════
function buildTrackStats(horse, currentTrack) {
  const starts = horse.startSummary?.lastStarts || horse.results || [];
  const trackMap = {};

  for (const s of starts) {
    const tn = s.track?.name || s.trackName;
    if (!tn) continue;
    if (!trackMap[tn]) trackMap[tn] = { track: tn, starts: 0, wins: 0 };
    trackMap[tn].starts++;
    if ((s.place || s.finishOrder) === 1) trackMap[tn].wins++;
  }

  return Object.values(trackMap)
    .map(t => ({ ...t, winPct: t.starts > 0 ? Math.round(t.wins / t.starts * 100) : 0 }))
    .sort((a, b) => {
      // Current track first
      if (a.track === currentTrack) return -1;
      if (b.track === currentTrack) return 1;
      return b.starts - a.starts;
    })
    .slice(0, 5);
}

// ═══════════════════════════════════════════
// HISTORICAL WIN %
// ═══════════════════════════════════════════
function calcHistWinPct(horse) {
  const summary = horse.startSummary || {};
  const starts = summary.starts || 0;
  const wins = summary.wins || summary.firsts || 0;

  if (starts > 0) return Math.round(wins / starts * 100);

  // Fallback: count from results
  const results = horse.startSummary?.lastStarts || horse.results || [];
  if (!results.length) return 0;
  const w = results.filter(r => (r.place || r.finishOrder) === 1).length;
  return Math.round(w / results.length * 100);
}

// ═══════════════════════════════════════════
// FLAGS / SIGNALER
// ═══════════════════════════════════════════
function buildFlags(start, horse, driver, trainer, times, formStr, valueScore) {
  const flags = [];

  // Form-häst (2+ vinster senaste 5)
  const vCount = (formStr.match(/V/g) || []).length;
  if (vCount >= 2) flags.push(`🔥 Form-häst – ${vCount}V senaste ${formStr.length}`);

  // Spetshäst
  if (start.postPosition <= 2 || start.number <= 2) {
    flags.push(`🏃 Spetshäst – spår ${start.postPosition || start.number}`);
  }

  // Förbättrade km-tider
  if (times.trend === 'improving') flags.push('📈 Förbättrade km-tider');

  // Kusk i form
  const dStats = buildPersonStats(driver);
  if (dStats.form30?.winPct >= 18) {
    flags.push(`🎯 Kusk i form ${dStats.form30.winPct}%`);
  }

  // Kusk i dålig form
  if (dStats.form30?.winPct > 0 && dStats.form30.winPct < 8) {
    flags.push(`⚠️ Kusk i svag form ${dStats.form30.winPct}%`);
  }

  // Vann senast
  if (formStr[0] === 'V') flags.push('⚡ Vann senast');

  // Undervärderad
  if (valueScore > 10) flags.push('💎 Kraftigt undervärderad');

  // Stallbyte / kuskbyte
  if (start.driverChanged) flags.push('🔄 Kuskbyte');

  // Tider i fältet (best km)
  if (times.best && times.best <= 72) flags.push('⚡ Toppfart i fältet');

  return flags.slice(0, 4);
}

// ═══════════════════════════════════════════
// FRONT RUNNER SCORE
// ═══════════════════════════════════════════
function calcFrontRunner(start, race) {
  let score = 0;
  const pos = start.postPosition || start.number;

  if (race.startMethod === 'auto') {
    if (pos <= 2) score += 4;
    else if (pos <= 4) score += 2;
  } else {
    // Volt: inner post = advantage
    if (pos === 1) score += 5;
    else if (pos === 2) score += 3;
    else if (pos <= 4) score += 1;
  }

  // Form factor
  const form = buildFormString(start.horse || {});
  const vCount = (form.match(/V/g) || []).length;
  score += vCount;

  return Math.min(10, score);
}

// ═══════════════════════════════════════════
// INSIGHTS
// ═══════════════════════════════════════════
function calcInsights(horses) {
  // Likely front runner
  const byFR = [...horses].sort((a, b) => b.frontRunnerScore - a.frontRunnerScore);
  const likelyFrontRunner = byFR[0]?.frontRunnerScore >= 3 ? {
    nr: byFR[0].nr,
    name: byFR[0].name,
    score: byFR[0].frontRunnerScore,
    reason: buildFRReason(byFR[0]),
  } : null;

  // Top value horse
  const byVal = [...horses].filter(h => h.valueScore > 4).sort((a, b) => b.valueScore - a.valueScore);
  const topValueHorse = byVal[0] ? {
    nr: byVal[0].nr,
    name: byVal[0].name,
    valueScore: byVal[0].valueScore,
    odds: byVal[0].winOdds,
    histWinPct: calcHistWinPct_from_horse(byVal[0]),
  } : null;

  // Missed horses (undervalued by the market)
  const missedHorses = horses
    .filter(h => h.valueScore > 6 && h.winOdds > 5)
    .sort((a, b) => b.valueScore - a.valueScore)
    .slice(0, 2)
    .map(h => ({
      nr: h.nr,
      name: h.name,
      odds: h.winOdds,
      valueScore: h.valueScore,
      reason: h.flags.slice(0, 2).join(' · ') || 'Undervärderad',
    }));

  return { likelyFrontRunner, topValueHorse, missedHorses, formHorses: [] };
}

function calcHistWinPct_from_horse(h) {
  // Rough estimate from form string
  const form = h.history?.formStr || '';
  const total = form.length || 1;
  const wins = (form.match(/V/g) || []).length;
  return Math.round(wins / total * 100);
}

function buildFRReason(h) {
  const parts = [];
  if (h.postPosition <= 2) parts.push(`Spår ${h.postPosition}`);
  if (h.flags?.some(f => f.includes('Form'))) parts.push('Topform');
  if (h.flags?.some(f => f.includes('Kusk i form'))) parts.push('Kusk i form');
  return parts.join(' · ') || 'Stark position';
}

// ═══════════════════════════════════════════
// SCOUT ANALYSIS (auto-generated text)
// ═══════════════════════════════════════════
function buildScoutAnalysis(horses, insights, race) {
  const parts = [];
  const fr = insights.likelyFrontRunner;
  const tv = insights.topValueHorse;

  if (fr) {
    const frH = horses.find(h => h.nr === fr.nr);
    parts.push(`${frH.name} (${frH.nr}) ser ut att ta spets från ${race.startMethod === 'auto' ? 'autostart' : 'voltstart'} med ${frH.driver?.name || 'sin kusk'}.`);
  }

  if (tv && tv.nr !== fr?.nr) {
    const tvH = horses.find(h => h.nr === tv.nr);
    parts.push(`${tvH.name} (${tvH.nr}) sticker ut som värdehäst – oddset ${tvH.winOdds} verkar för högt baserat på form och historik (EV +${tv.valueScore}%).`);
  }

  const missed = insights.missedHorses || [];
  if (missed.length > 0 && missed[0].nr !== fr?.nr && missed[0].nr !== tv?.nr) {
    parts.push(`Håll koll på ${missed[0].name} (${missed[0].nr}) @ ${missed[0].odds} – ${missed[0].reason}.`);
  }

  // Overall character
  const topOdds = horses.filter(h => h.winOdds).sort((a, b) => a.winOdds - b.winOdds);
  if (topOdds.length >= 2 && topOdds[0].winOdds < 2.5) {
    parts.push('Tydlig favorit – ett potentiellt singelläge.');
  } else if (topOdds.length >= 2 && topOdds[0].winOdds > 4) {
    parts.push('Jämnt och öppet lopp – gardering rekommenderas.');
  }

  return parts.join(' ') || 'Ingen tydlig favorit – jämnt lopp.';
}

// ═══════════════════════════════════════════
// MARK SCOUT PICKS
// ═══════════════════════════════════════════
function markScoutPicks(horses, insights) {
  // Sort by a composite score
  const scored = horses.map(h => ({
    h,
    score: (h.valueScore || 0) * 0.4
         + (h.frontRunnerScore || 0) * 3
         + ((h.history?.formStr || '').match(/V/g) || []).length * 5
         + (h.driver?.inForm ? 5 : 0)
         + (h.trainer?.inForm ? 3 : 0)
         + (h.history?.timeTrend === 'improving' ? 4 : 0)
  })).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return;

  // Top pick = singel if strong enough lead
  const gap = scored.length >= 2 ? scored[0].score - scored[1].score : 999;

  if (gap > 8) {
    // Strong singel
    scored[0].h.scoutPick = true;
    scored[0].h.scoutPickType = 'singel';
  } else {
    // Gardering: top 2
    scored[0].h.scoutPick = true;
    scored[0].h.scoutPickType = 'gardering';
    if (scored.length >= 2) {
      scored[1].h.scoutPick = true;
      scored[1].h.scoutPickType = 'gardering';
    }
  }
}

// ═══════════════════════════════════════════
// RESPONSE HELPER
// ═══════════════════════════════════════════
function res(code, body, headers) {
  return {
    statusCode: code,
    headers,
    body: JSON.stringify(body),
  };
}
