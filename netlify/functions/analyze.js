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

    var gameData = await apiFetch(ATG + '/games/' + gameId);
    if (!gameData || !gameData.races || !gameData.races.length) {
      return reply(404, { error: 'Inga lopp i spelet: ' + gameId }, headers);
    }

    var races = [];
    for (var i = 0; i < gameData.races.length; i++) {
      try { races.push(processRace(gameData.races[i])); } catch (e) { console.log('[V85] Skip race:', e.message); }
    }
    if (!races.length) return reply(500, { error: 'Kunde inte bearbeta loppdata.' }, headers);

    // Generera kuponger
    var coupons = generateCoupons(races);

    var trackName = '';
    if (gameData.tracks && gameData.tracks.length) trackName = gameData.tracks[0].name || '';
    if (!trackName && races.length) trackName = races[0].track || '';

    return reply(200, {
      gameId: gameId, track: trackName,
      date: extractDate(gameId), races: races,
      coupons: coupons,
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
  } catch (e) { console.log('[V85] Products fetch failed:', e.message); }
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
// PROCESS RACE
// ═══════════════════════════════════════
function processRace(race) {
  var starts = race.starts || [];
  var horses = [];
  for (var i = 0; i < starts.length; i++) {
    try { horses.push(processHorse(starts[i], race)); } catch (e) {}
  }

  // Berakna sannolikheter
  calcProbabilities(horses);

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
// PROCESS HORSE
// ═══════════════════════════════════════
function processHorse(start, race) {
  var horse = start.horse || {};
  var driverRaw = start.driver || {};
  var trainerRaw = horse.trainer || {};

  var driverName = buildName(driverRaw);
  var trainerName = buildName(trainerRaw);

  // Odds
  var winOdds = null;
  var pools = start.pools || {};
  var poolKeys = ['vinnare', 'V85', 'V75', 'V86'];
  for (var p = 0; p < poolKeys.length; p++) {
    if (pools[poolKeys[p]] && pools[poolKeys[p]].odds) { winOdds = pools[poolKeys[p]].odds / 100; break; }
  }
  if (!winOdds && start.vpOdds) winOdds = start.vpOdds / 100;
  if (!winOdds && start.odds) winOdds = start.odds / 100;

  // Statistik
  var horseStats = horse.statistics || {};
  var lifeStats = horseStats.life || {};
  var yearStats = getLatestYearStats(horseStats);
  var trainerYearStats = getLatestYearStats(trainerRaw.statistics || {});
  var driverYearStats = getLatestYearStats(driverRaw.statistics || {});

  // Km-tider
  var times = extractTimes(horse, lifeStats);

  // Vinst%
  var lifeStarts = lifeStats.starts || 0;
  var lifeWins = lifeStats.placement ? (parseInt(lifeStats.placement['1']) || 0) : 0;
  var histPct = lifeStarts > 0 ? Math.round(lifeWins / lifeStarts * 100) : 0;

  var yearStarts2 = yearStats.starts || 0;
  var yearWins2 = yearStats.placement ? (parseInt(yearStats.placement['1']) || 0) : 0;
  var yearWinPct = yearStarts2 > 0 ? Math.round(yearWins2 / yearStarts2 * 100) : 0;

  // Value Score
  var implPct = winOdds ? (100 / winOdds) : 0;
  var valueScore = Math.round((histPct - implPct) * 10) / 10;

  // Kusk/Tranare
  var driverWinPct = driverYearStats.winPercentage ? Math.round(driverYearStats.winPercentage / 100) : 0;
  var trainerWinPct = trainerYearStats.winPercentage ? Math.round(trainerYearStats.winPercentage / 100) : 0;
  var driverStarts = driverYearStats.starts || 0;
  var driverWins = driverYearStats.placement ? (parseInt(driverYearStats.placement['1']) || 0) : 0;
  var trainerStarts = trainerYearStats.starts || 0;
  var trainerWins = trainerYearStats.placement ? (parseInt(trainerYearStats.placement['1']) || 0) : 0;

  var frScore = frontRunnerScore(start, race);

  // Earnings
  var earnings = horse.money || 0;
  var earningsStr = earnings > 0 ? Math.round(earnings / 100) : 0;

  // Flags
  var flags = [];
  if (yearWinPct >= 30) flags.push('🔥 Hog vinstprocent ' + yearWinPct + '%');
  if (lifeWins >= 3 && histPct >= 25) flags.push('🏆 ' + lifeWins + ' vinster pa ' + lifeStarts + ' starter');
  if ((start.postPosition || start.number) <= 2) flags.push('🏃 Spets spar ' + (start.postPosition || start.number));
  if (driverWinPct >= 18) flags.push('🎯 Kusk i form ' + driverWinPct + '%');
  if (driverWinPct > 0 && driverWinPct < 8) flags.push('⚠️ Kusk i svag form');
  if (trainerWinPct >= 18) flags.push('🔥 Tranare i form ' + trainerWinPct + '%');
  if (start.shoes && start.shoes.front && !start.shoes.front.hasShoe && start.shoes.front.changed) flags.push('🔧 Skor av fram');
  if (valueScore > 10) flags.push('💎 Undervarderad');
  flags = flags.slice(0, 4);

  return {
    nr: start.number,
    name: horse.name || ('Hast ' + start.number),
    winOdds: winOdds,
    postPosition: start.postPosition || start.number,
    probability: 0, // Beraknas i calcProbabilities
    history: { formStr: '', avgKmTime10: times.avg, bestKmTime: times.best, timeTrend: times.trend, recentStarts: [], trackStats: [] },
    driver: { name: driverName, yearPct: driverWinPct, form30: { starts: driverStarts, wins: driverWins, winPct: driverWinPct }, form14: { starts: Math.round(driverStarts / 2), wins: Math.round(driverWins / 2), winPct: driverWinPct }, inForm: driverWinPct >= 18 },
    trainer: { name: trainerName, yearPct: trainerWinPct, form30: { starts: trainerStarts, wins: trainerWins, winPct: trainerWinPct }, form14: { starts: Math.round(trainerStarts / 2), wins: Math.round(trainerWins / 2), winPct: trainerWinPct }, inForm: trainerWinPct >= 18 },
    flags: flags, valueScore: valueScore, frontRunnerScore: frScore,
    _lifeStarts: lifeStarts, _lifeWins: lifeWins, _yearWinPct: yearWinPct,
    _driverWinPct: driverWinPct, _trainerWinPct: trainerWinPct,
    _bestTime: times.best, _earnings: earningsStr,
    analysis: '', scoutPick: false, scoutPickType: null
  };
}

// ═══════════════════════════════════════
// PROBABILITY CALCULATION
// Viktat poang per hast -> normaliserat till %
// ═══════════════════════════════════════
function calcProbabilities(horses) {
  if (!horses.length) return;

  // Basta km-tid i faltet for jamforelse
  var bestTimeInField = 999;
  for (var i = 0; i < horses.length; i++) {
    if (horses[i]._bestTime && horses[i]._bestTime < bestTimeInField) bestTimeInField = horses[i]._bestTime;
  }

  var scores = [];
  var totalScore = 0;

  for (var j = 0; j < horses.length; j++) {
    var h = horses[j];
    var score = 10; // Baspoang

    // 1. Hastens vinstprocent (livstid, viktigast)
    var histPct = h._lifeStarts > 0 ? (h._lifeWins / h._lifeStarts * 100) : 0;
    score += histPct * 1.5; // Max ~45 poang for 30%

    // 2. Arets form
    score += (h._yearWinPct || 0) * 0.8;

    // 3. Kuskens form
    score += (h._driverWinPct || 0) * 0.6;

    // 4. Tranarens form
    score += (h._trainerWinPct || 0) * 0.4;

    // 5. Sparfordel (volt/auto)
    score += h.frontRunnerScore * 2;

    // 6. Km-tid vs faltet
    if (h._bestTime && bestTimeInField < 999) {
      var timeDiff = h._bestTime - bestTimeInField;
      if (timeDiff <= 0) score += 15;
      else if (timeDiff < 1) score += 10;
      else if (timeDiff < 2) score += 5;
      else if (timeDiff < 4) score += 2;
    }

    // 7. Intjanat (hogre = battre klass)
    if (h._earnings > 500000) score += 8;
    else if (h._earnings > 200000) score += 5;
    else if (h._earnings > 100000) score += 3;

    // 8. Odds-baserat (om tillgangligt, marknadens bedomning)
    if (h.winOdds) {
      var oddsScore = 100 / h.winOdds;
      score += oddsScore * 0.5;
    }

    scores.push(score);
    totalScore += score;
  }

  // Normalisera till procent
  for (var k = 0; k < horses.length; k++) {
    horses[k].probability = totalScore > 0 ? Math.round(scores[k] / totalScore * 1000) / 10 : 0;
  }
}

// ═══════════════════════════════════════
// GENERATE COUPONS
// ═══════════════════════════════════════
function generateCoupons(races) {
  // Sortera hastar per lopp efter sannolikhet
  var raceAnalysis = races.map(function(race) {
    var sorted = race.horses.slice().sort(function(a, b) { return b.probability - a.probability; });
    var top = sorted[0] || {};
    var second = sorted[1] || {};
    var third = sorted[2] || {};

    // Berakna "singlebarhet" - hur sakert ar topphasten?
    var gap = top.probability - (second.probability || 0);
    var confidence = 'low';
    if (gap > 15) confidence = 'high';
    else if (gap > 8) confidence = 'medium';

    return {
      raceNumber: race.raceNumber,
      name: race.name,
      confidence: confidence,
      gap: gap,
      top: { nr: top.nr, name: top.name, pct: top.probability, odds: top.winOdds },
      second: second.nr ? { nr: second.nr, name: second.name, pct: second.probability, odds: second.winOdds } : null,
      third: third.nr ? { nr: third.nr, name: third.name, pct: third.probability, odds: third.winOdds } : null,
      allSorted: sorted.slice(0, 5).map(function(h) { return { nr: h.nr, name: h.name, pct: h.probability, odds: h.winOdds }; })
    };
  });

  // ─── SPIK-KUPONG (billigast, max singlar) ───
  var spik = buildCoupon(raceAnalysis, 'spik');
  // ─── MELLAN-KUPONG (balanserad) ───
  var mellan = buildCoupon(raceAnalysis, 'mellan');
  // ─── BRED KUPONG (flest garderingar) ───
  var bred = buildCoupon(raceAnalysis, 'bred');

  return {
    analysis: raceAnalysis,
    spik: spik,
    mellan: mellan,
    bred: bred
  };
}

function buildCoupon(analysis, type) {
  // Malkostnad per typ
  var targetRader;
  if (type === 'spik') targetRader = 100;       // ~50 kr
  else if (type === 'mellan') targetRader = 300; // ~150 kr
  else targetRader = 1000;                       // ~500 kr

  // Sortera lopp efter confidence (lagst forst = bor garderas forst)
  var sorted = analysis.slice().sort(function(a, b) { return a.gap - b.gap; });

  // Starta med alla singlar
  var pickMap = {};
  for (var i = 0; i < sorted.length; i++) {
    pickMap[sorted[i].raceNumber] = { singel: true, horses: [sorted[i].top], available: [sorted[i].top, sorted[i].second, sorted[i].third].filter(Boolean) };
  }

  // Berakna rader
  function countRader() {
    var r = 1;
    for (var rn in pickMap) r *= pickMap[rn].horses.length;
    return r;
  }

  // Iterativt lagg till hastar tills vi narmar oss budget
  // Forsta passet: oppna ossakra lopp till 2 hastar
  for (var pass1 = 0; pass1 < sorted.length; pass1++) {
    if (countRader() >= targetRader) break;
    var race1 = sorted[pass1];
    var pick1 = pickMap[race1.raceNumber];
    if (pick1.horses.length < 2 && pick1.available.length >= 2) {
      pick1.horses = pick1.available.slice(0, 2);
      pick1.singel = false;
    }
  }

  // Andra passet: oppna till 3 hastar om vi fortfarande ar under budget
  for (var pass2 = 0; pass2 < sorted.length; pass2++) {
    if (countRader() >= targetRader) break;
    var race2 = sorted[pass2];
    var pick2 = pickMap[race2.raceNumber];
    if (pick2.horses.length < 3 && pick2.available.length >= 3) {
      pick2.horses = pick2.available.slice(0, 3);
      pick2.singel = false;
    }
  }

  // Tredje passet (bara bred): oppna till 4 hastar
  if (type === 'bred') {
    for (var pass3 = 0; pass3 < sorted.length; pass3++) {
      if (countRader() >= targetRader) break;
      var race3 = sorted[pass3];
      var pick3 = pickMap[race3.raceNumber];
      if (pick3.horses.length < 4) {
        var allH = race3.allSorted || [];
        var more = [];
        for (var m = 0; m < Math.min(4, allH.length); m++) more.push(allH[m]);
        if (more.length > pick3.horses.length) {
          pick3.horses = more;
          pick3.singel = false;
        }
      }
    }
  }

  // Bygg output i loppordning
  var rader = 1;
  var singlar = 0;
  var gard = 0;
  var picks = [];
  for (var j = 0; j < analysis.length; j++) {
    var rn = analysis[j].raceNumber;
    var pick = pickMap[rn];
    rader *= pick.horses.length;
    if (pick.horses.length === 1) singlar++;
    else gard++;
    picks.push({
      raceNumber: rn,
      raceName: analysis[j].name,
      singel: pick.horses.length === 1,
      horses: pick.horses
    });
  }

  var kostnad = Math.round(rader * 0.5);
  var label, description;
  if (type === 'spik') {
    label = '🎯 Spikkupong';
    description = 'Smal kupong runt 50 kr. Singlar sakra lopp, nagon gardering.';
  } else if (type === 'mellan') {
    label = '⚖️ Mellankupong';
    description = 'Balanserad kupong runt 150 kr. Garderar ossakra lopp med 2-3 hastar.';
  } else {
    label = '🛡️ Bred kupong';
    description = 'Bred kupong runt 500 kr. Maximal tackning med flera garderingar.';
  }

  return {
    label: label,
    description: description,
    rader: rader,
    kostnad: kostnad,
    singlar: singlar,
    garderingar: gard,
    picks: picks
  };
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function buildName(person) {
  if (!person) return '';
  return ((person.firstName || '') + ' ' + (person.lastName || '')).trim() || person.name || '';
}

function getLatestYearStats(stats) {
  if (!stats || !stats.years) return {};
  var keys = Object.keys(stats.years).sort().reverse();
  return keys.length > 0 ? stats.years[keys[0]] : {};
}

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
  if (horse.record && horse.record.time) {
    var t = horse.record.time;
    var s = (t.minutes || 1) * 60 + (t.seconds || 0) + (t.tenths || 0) / 10;
    if (s > 50 && s < 100 && times.indexOf(s) === -1) times.push(s);
  }
  if (!times.length) return { avg: null, best: null, trend: 'stable' };
  var sum = 0;
  for (var j = 0; j < times.length; j++) sum += times[j];
  return { avg: Math.round(sum / times.length * 10) / 10, best: Math.round(Math.min.apply(null, times) * 10) / 10, trend: 'stable' };
}

function frontRunnerScore(start, race) {
  var score = 0;
  var pos = start.postPosition || start.number;
  var method = (race.startMethod || '').toLowerCase();
  if (method === 'auto') { if (pos <= 2) score += 4; else if (pos <= 4) score += 2; }
  else { if (pos === 1) score += 5; else if (pos === 2) score += 3; else if (pos <= 4) score += 1; }
  return Math.min(10, score);
}

function calcInsights(horses) {
  var byFR = horses.slice().sort(function(a, b) { return b.frontRunnerScore - a.frontRunnerScore; });
  var likelyFrontRunner = null;
  if (byFR.length && byFR[0].frontRunnerScore >= 3) {
    likelyFrontRunner = { nr: byFR[0].nr, name: byFR[0].name, score: byFR[0].frontRunnerScore, reason: frReason(byFR[0]) };
  }
  var byVal = horses.filter(function(h) { return h.valueScore > 4; }).sort(function(a, b) { return b.valueScore - a.valueScore; });
  var topValueHorse = byVal.length ? { nr: byVal[0].nr, name: byVal[0].name, valueScore: byVal[0].valueScore, odds: byVal[0].winOdds, histWinPct: 0 } : null;
  var missed = horses.filter(function(h) { return h.valueScore > 6 && h.winOdds && h.winOdds > 5; }).sort(function(a, b) { return b.valueScore - a.valueScore; }).slice(0, 2).map(function(h) {
    return { nr: h.nr, name: h.name, odds: h.winOdds, valueScore: h.valueScore, reason: h.flags.slice(0, 2).join(' · ') || 'Undervarderad' };
  });
  return { likelyFrontRunner: likelyFrontRunner, topValueHorse: topValueHorse, missedHorses: missed, formHorses: [] };
}

function frReason(h) {
  var parts = [];
  if (h.postPosition <= 2) parts.push('Spar ' + h.postPosition);
  for (var i = 0; i < h.flags.length; i++) { if (h.flags[i].indexOf('orm') !== -1) { parts.push('I form'); break; } }
  return parts.join(' · ') || 'Stark position';
}

function buildScoutText(horses, insights, race) {
  var sorted = horses.slice().sort(function(a, b) { return b.probability - a.probability; });
  var parts = [];
  if (sorted.length >= 2) {
    var top = sorted[0];
    var gap = top.probability - sorted[1].probability;
    if (gap > 15) {
      parts.push(top.name + ' (' + top.nr + ') ar tydlig favorit med ' + top.probability + '% sannolikhet – potentiell singel.');
    } else if (gap > 8) {
      parts.push(top.name + ' (' + top.nr + ', ' + top.probability + '%) ar forstaval men ' + sorted[1].name + ' (' + sorted[1].nr + ', ' + sorted[1].probability + '%) kan utmana.');
    } else {
      parts.push('Jamnt lopp! ' + top.name + ' (' + top.probability + '%) och ' + sorted[1].name + ' (' + sorted[1].probability + '%) ligger nara – gardering rekommenderas.');
    }
  }
  if (sorted.length && sorted[0].driver && sorted[0].driver.inForm) {
    parts.push(sorted[0].driver.name + ' ar i stark form.');
  }
  return parts.join(' ') || 'Analyserar...';
}

function markPicks(horses) {
  var scored = horses.slice().sort(function(a, b) { return b.probability - a.probability; });
  if (!scored.length) return;
  var gap = scored.length >= 2 ? scored[0].probability - scored[1].probability : 999;
  if (gap > 12) { scored[0].scoutPick = true; scored[0].scoutPickType = 'singel'; }
  else {
    scored[0].scoutPick = true; scored[0].scoutPickType = 'gardering';
    if (scored.length >= 2) { scored[1].scoutPick = true; scored[1].scoutPickType = 'gardering'; }
  }
}

function reply(code, body, headers) {
  return { statusCode: code, headers: headers, body: JSON.stringify(body) };
}
