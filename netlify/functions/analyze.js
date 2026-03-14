const ATG = 'https://www.atg.se/services/racinginfo/v1/api';

exports.handler = async function(event, context) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };

  try {
    var raw = (event.queryStringParameters || {}).game || '';
    if (!raw.trim()) return reply(400, { error: 'Ange t.ex. V85 eller V85_2026-03-14' }, headers);
    raw = raw.trim();

    var gameId = await resolveGameId(raw);
    if (!gameId) return reply(404, { error: 'Hittade inget V85-spel for: ' + raw }, headers);
    console.log('[V85] Game ID:', gameId);

    // Hamta GAMES-endpointen (har pooler + lopp + hastar)
    var gameData = await apiFetch(ATG + '/games/' + gameId);
    if (!gameData || !gameData.races || !gameData.races.length) {
      return reply(404, { error: 'Inga lopp i spelet: ' + gameId }, headers);
    }

    // Bearbeta lopp direkt fran games-svaret
    var races = [];
    for (var i = 0; i < gameData.races.length; i++) {
      try { races.push(processRace(gameData.races[i])); } catch (e) { console.log('[V85] Skip race:', e.message); }
    }
    if (!races.length) return reply(500, { error: 'Kunde inte bearbeta loppdata.' }, headers);

    var trackName = '';
    if (gameData.tracks && gameData.tracks.length) trackName = gameData.tracks[0].name || '';
    if (!trackName && races.length) trackName = races[0].track || '';

    return reply(200, {
      gameId: gameId, track: trackName,
      date: extractDate(gameId), races: races,
      fetchedAt: new Date().toISOString()
    }, headers);

  } catch (err) {
    console.error('[V85] Error:', err);
    return reply(500, { error: 'Serverfel: ' + err.message }, headers);
  }
};

// ═══════════════════════════════════════
// RESOLVE GAME ID
// ═══════════════════════════════════════
async function resolveGameId(raw) {
  var full = raw.match(/(V8[56]_\d{4}-\d{2}-\d{2}_\d+_\d+)/i);
  if (full) return full[1];

  try {
    var prod = await apiFetch(ATG + '/products/V85');
    if (!prod) return null;
    var upcoming = prod.upcoming || [];
    var dateMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      var date = dateMatch[1];
      for (var i = 0; i < upcoming.length; i++) {
        if (upcoming[i].id && upcoming[i].id.indexOf(date) !== -1) return upcoming[i].id;
      }
    }
    if (upcoming.length > 0 && upcoming[0].id) return upcoming[0].id;
  } catch (e) {
    console.log('[V85] Products fetch failed:', e.message);
  }
  return null;
}

async function apiFetch(url) {
  console.log('[V85] GET', url);
  var res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error('ATG ' + res.status + ' for ' + url);
  return res.json();
}

function extractDate(gameId) {
  var m = (gameId || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// ═══════════════════════════════════════
// PROCESS RACE (from games endpoint)
// ═══════════════════════════════════════
function processRace(race) {
  var starts = race.starts || [];
  var horses = [];
  for (var i = 0; i < starts.length; i++) {
    try { horses.push(processHorse(starts[i], race)); } catch (e) { console.log('[V85] Skip horse:', e.message); }
  }
  var insights = calcInsights(horses);
  var scoutAnalysis = buildScoutText(horses, insights, race);
  markPicks(horses);
  return {
    raceNumber: race.number || 0,
    name: race.name || ('Lopp ' + (race.number || '?')),
    track: race.track ? (race.track.name || '') : '',
    distance: race.distance || null,
    startMethod: (race.startMethod || '').toLowerCase() === 'auto' ? 'auto' : 'volt',
    startTime: race.startTime || race.scheduledStartTime || null,
    scoutAnalysis: scoutAnalysis, horses: horses, insights: insights
  };
}

// ═══════════════════════════════════════
// PROCESS HORSE (ATG real format)
// ═══════════════════════════════════════
function processHorse(start, race) {
  var horse = start.horse || {};
  var driverRaw = start.driver || {};
  var trainerRaw = horse.trainer || {};

  // ── NAMN ──
  var driverName = buildName(driverRaw);
  var trainerName = buildName(trainerRaw);

  // ── ODDS ──
  // ATG: vinnar-odds kan ligga pa start-niva eller i pooler
  var winOdds = null;
  // Kolla start.pools
  var pools = start.pools || {};
  var poolKeys = ['vinnare', 'V85', 'V75', 'V86'];
  for (var p = 0; p < poolKeys.length; p++) {
    if (pools[poolKeys[p]] && pools[poolKeys[p]].odds) {
      winOdds = pools[poolKeys[p]].odds / 100;
      break;
    }
  }
  // Fallback: vpOdds, odds direkt
  if (!winOdds && start.vpOdds) winOdds = start.vpOdds / 100;
  if (!winOdds && start.odds) winOdds = start.odds / 100;
  // Fallback: lastFiveStarts averageOdds
  if (!winOdds && horse.statistics && horse.statistics.lastFiveStarts && horse.statistics.lastFiveStarts.averageOdds) {
    winOdds = horse.statistics.lastFiveStarts.averageOdds / 100;
  }

  // ── STATISTIK (ATG format) ──
  var horseStats = horse.statistics || {};
  var lifeStats = horseStats.life || {};
  var yearStats = getLatestYearStats(horseStats);
  var trainerYearStats = getLatestYearStats(trainerRaw.statistics || {});
  var driverYearStats = getLatestYearStats(driverRaw.statistics || {});

  // ── FORM STRING ──
  var formStr = '';
  if (lifeStats.placement) {
    // Bygg fran senaste starter om tillgangligt
  }
  // Prova lastFiveStarts
  if (horseStats.lastFiveStarts) {
    // Vi har inte individuella resultat, bygg fran vinstprocent
  }

  // ── RECORDS / KM-TIDER ──
  var times = extractTimes(horse, lifeStats);

  // ── VINST% ──
  var lifeStarts = lifeStats.starts || 0;
  var lifeWins = lifeStats.placement ? (parseInt(lifeStats.placement['1']) || 0) : 0;
  var histPct = lifeStarts > 0 ? Math.round(lifeWins / lifeStarts * 100) : 0;

  // ── VALUE SCORE ──
  var implPct = winOdds ? (100 / winOdds) : 0;
  var valueScore = Math.round((histPct - implPct) * 10) / 10;

  // ── KUSK/TRANARE FORM (ATG: winPercentage = 1578 = 15.78%) ──
  var driverWinPct = driverYearStats.winPercentage ? Math.round(driverYearStats.winPercentage / 100) : 0;
  var trainerWinPct = trainerYearStats.winPercentage ? Math.round(trainerYearStats.winPercentage / 100) : 0;
  var driverStarts = driverYearStats.starts || 0;
  var driverWins = driverYearStats.placement ? (parseInt(driverYearStats.placement['1']) || 0) : 0;
  var trainerStarts = trainerYearStats.starts || 0;
  var trainerWins = trainerYearStats.placement ? (parseInt(trainerYearStats.placement['1']) || 0) : 0;

  // ── FRONT RUNNER ──
  var frScore = frontRunnerScore(start, race);

  // ── FLAGS ──
  var flags = [];
  var yearWinPct = yearStats.winPercentage ? Math.round(yearStats.winPercentage / 100) : 0;
  if (yearWinPct >= 30) flags.push('🔥 Hog vinstprocent ' + yearWinPct + '%');
  if ((start.postPosition || start.number) <= 2) flags.push('🏃 Spetsposition spar ' + (start.postPosition || start.number));
  if (driverWinPct >= 18) flags.push('🎯 Kusk i form ' + driverWinPct + '%');
  if (driverWinPct > 0 && driverWinPct < 8) flags.push('⚠️ Kusk i svag form');
  if (trainerWinPct >= 18) flags.push('🔥 Tranare i form ' + trainerWinPct + '%');
  if (start.shoes && start.shoes.front && !start.shoes.front.hasShoe) flags.push('🔧 Skor av fram');
  if (horse.money && horse.money > 500000) flags.push('💰 ' + Math.round(horse.money / 100) + ' kr intjanat');
  if (valueScore > 10) flags.push('💎 Kraftigt undervarderad');
  flags = flags.slice(0, 4);

  return {
    nr: start.number,
    name: horse.name || ('Hast ' + start.number),
    winOdds: winOdds,
    postPosition: start.postPosition || start.number,
    history: {
      formStr: formStr || '',
      avgKmTime10: times.avg,
      bestKmTime: times.best,
      timeTrend: times.trend,
      recentStarts: [],
      trackStats: []
    },
    driver: {
      name: driverName,
      yearPct: driverWinPct,
      form30: { starts: driverStarts, wins: driverWins, winPct: driverWinPct },
      form14: { starts: Math.round(driverStarts / 2), wins: Math.round(driverWins / 2), winPct: driverWinPct },
      inForm: driverWinPct >= 18
    },
    trainer: {
      name: trainerName,
      yearPct: trainerWinPct,
      form30: { starts: trainerStarts, wins: trainerWins, winPct: trainerWinPct },
      form14: { starts: Math.round(trainerStarts / 2), wins: Math.round(trainerWins / 2), winPct: trainerWinPct },
      inForm: trainerWinPct >= 18
    },
    flags: flags,
    valueScore: valueScore,
    frontRunnerScore: frScore,
    analysis: horse.raceComment || start.raceComment || '',
    scoutPick: false,
    scoutPickType: null
  };
}

function buildName(person) {
  if (!person) return '';
  var first = person.firstName || '';
  var last = person.lastName || '';
  return (first + ' ' + last).trim() || person.name || '';
}

function getLatestYearStats(stats) {
  if (!stats || !stats.years) return {};
  var years = stats.years;
  // Hamta senaste aret
  var keys = Object.keys(years).sort().reverse();
  if (keys.length > 0) return years[keys[0]];
  return {};
}

// ═══════════════════════════════════════
// TIMES FROM RECORDS
// ═══════════════════════════════════════
function extractTimes(horse, lifeStats) {
  var records = [];
  if (lifeStats && lifeStats.records) records = lifeStats.records;
  else if (horse.record) records = [horse.record];

  var times = [];
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    if (rec.time) {
      var secs = (rec.time.minutes || 1) * 60 + (rec.time.seconds || 0) + (rec.time.tenths || 0) / 10;
      if (secs > 50 && secs < 100) times.push(secs);
    }
  }

  // Also check horse.record
  if (horse.record && horse.record.time) {
    var t = horse.record.time;
    var s = (t.minutes || 1) * 60 + (t.seconds || 0) + (t.tenths || 0) / 10;
    if (s > 50 && s < 100 && times.indexOf(s) === -1) times.push(s);
  }

  if (!times.length) return { avg: null, best: null, trend: 'stable' };

  var sum = 0;
  for (var j = 0; j < times.length; j++) sum += times[j];
  var avg = sum / times.length;
  var best = Math.min.apply(null, times);

  return {
    avg: Math.round(avg * 10) / 10,
    best: Math.round(best * 10) / 10,
    trend: 'stable'
  };
}

// ═══════════════════════════════════════
// FRONT RUNNER
// ═══════════════════════════════════════
function frontRunnerScore(start, race) {
  var score = 0;
  var pos = start.postPosition || start.number;
  var method = (race.startMethod || '').toLowerCase();
  if (method === 'auto') { if (pos <= 2) score += 4; else if (pos <= 4) score += 2; }
  else { if (pos === 1) score += 5; else if (pos === 2) score += 3; else if (pos <= 4) score += 1; }
  return Math.min(10, score);
}

// ═══════════════════════════════════════
// INSIGHTS
// ═══════════════════════════════════════
function calcInsights(horses) {
  var byFR = horses.slice().sort(function(a, b) { return b.frontRunnerScore - a.frontRunnerScore; });
  var likelyFrontRunner = null;
  if (byFR.length && byFR[0].frontRunnerScore >= 3) {
    likelyFrontRunner = { nr: byFR[0].nr, name: byFR[0].name, score: byFR[0].frontRunnerScore, reason: frReason(byFR[0]) };
  }
  var byVal = horses.filter(function(h) { return h.valueScore > 4; }).sort(function(a, b) { return b.valueScore - a.valueScore; });
  var topValueHorse = null;
  if (byVal.length) {
    topValueHorse = { nr: byVal[0].nr, name: byVal[0].name, valueScore: byVal[0].valueScore, odds: byVal[0].winOdds, histWinPct: 0 };
  }
  var missed = horses.filter(function(h) { return h.valueScore > 6 && h.winOdds && h.winOdds > 5; }).sort(function(a, b) { return b.valueScore - a.valueScore; }).slice(0, 2).map(function(h) {
    return { nr: h.nr, name: h.name, odds: h.winOdds, valueScore: h.valueScore, reason: h.flags.slice(0, 2).join(' · ') || 'Undervarderad' };
  });
  return { likelyFrontRunner: likelyFrontRunner, topValueHorse: topValueHorse, missedHorses: missed, formHorses: [] };
}

function frReason(h) {
  var parts = [];
  if (h.postPosition <= 2) parts.push('Spar ' + h.postPosition);
  for (var i = 0; i < h.flags.length; i++) { if (h.flags[i].indexOf('form') !== -1 || h.flags[i].indexOf('Form') !== -1) { parts.push('I form'); break; } }
  return parts.join(' · ') || 'Stark position';
}

function buildScoutText(horses, insights, race) {
  var parts = [];
  var fr = insights.likelyFrontRunner;
  var tv = insights.topValueHorse;
  if (fr) {
    var frH = horses.find(function(h) { return h.nr === fr.nr; });
    if (frH) {
      var sm = (race.startMethod || '').toLowerCase() === 'auto' ? 'autostart' : 'voltstart';
      parts.push(frH.name + ' (' + frH.nr + ') ser ut att ta spets fran ' + sm + (frH.driver.name ? ' med ' + frH.driver.name : '') + '.');
    }
  }
  if (tv && (!fr || tv.nr !== fr.nr)) {
    var tvH = horses.find(function(h) { return h.nr === tv.nr; });
    if (tvH && tvH.winOdds) parts.push(tvH.name + ' (' + tvH.nr + ') sticker ut som vardehast pa odds ' + tvH.winOdds + '.');
  }
  var sorted = horses.filter(function(h) { return h.winOdds; }).sort(function(a, b) { return a.winOdds - b.winOdds; });
  if (sorted.length >= 2 && sorted[0].winOdds < 2.5) parts.push('Tydlig favorit – potentiellt singellage.');
  else if (sorted.length >= 2 && sorted[0].winOdds > 4) parts.push('Oppet lopp – gardering rekommenderas.');
  if (!parts.length) parts.push('Odds ej tillgangliga annu. Uppdateras automatiskt narmare start.');
  return parts.join(' ');
}

function markPicks(horses) {
  var scored = horses.map(function(h) {
    return { h: h, score: (h.valueScore || 0) * 0.4 + (h.frontRunnerScore || 0) * 3 + (h.driver && h.driver.inForm ? 5 : 0) + (h.trainer && h.trainer.inForm ? 3 : 0) };
  }).sort(function(a, b) { return b.score - a.score; });
  if (!scored.length) return;
  var gap = scored.length >= 2 ? scored[0].score - scored[1].score : 999;
  if (gap > 8) { scored[0].h.scoutPick = true; scored[0].h.scoutPickType = 'singel'; }
  else { scored[0].h.scoutPick = true; scored[0].h.scoutPickType = 'gardering'; if (scored.length >= 2) { scored[1].h.scoutPick = true; scored[1].h.scoutPickType = 'gardering'; } }
}

function reply(code, body, headers) {
  return { statusCode: code, headers: headers, body: JSON.stringify(body) };
}
