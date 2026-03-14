
// V85 Scout Pro – Netlify Serverless Function
// Hämtar data från ATG:s publika API, beräknar analyser och returnerar JSON
// Inga externa dependencies – använder Node 18 inbyggd fetch

const ATG = 'https://www.atg.se/services/racinginfo/v1/api';

exports.handler = async function(event, context) {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const raw = (event.queryStringParameters || {}).game || '';
    if (!raw.trim()) {
      return reply(400, { error: 'Ange spel-ID, t.ex. V85_2026-03-15_1' }, headers);
    }

    const gameId = parseGameId(raw.trim());
    if (!gameId) {
      return reply(400, { error: 'Ogiltigt format. Ange t.ex. V85_2026-03-15_1' }, headers);
    }

    // 1) Hämta spelinfo
    const gameUrl = ATG + '/games/' + gameId;
    console.log('[V85] GET', gameUrl);

    const gameRes = await fetch(gameUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (!gameRes.ok) {
      const status = gameRes.status;
      if (status === 404) {
        return reply(404, { error: 'Hittade inget spel med ID: ' + gameId + '. Kontrollera datum och nummer.' }, headers);
      }
      return reply(502, { error: 'ATG svarade med ' + status + ' för ' + gameId }, headers);
    }

    const game = await gameRes.json();

    if (!game.races || !game.races.length) {
      return reply(404, { error: 'Spelet hittades men har inga lopp.' }, headers);
    }

    // 2) Hämta varje lopp parallellt
    const racePromises = game.races.map(function(r) {
      const raceId = r.id || r.raceId;
      if (!raceId) return Promise.resolve(null);
      return fetch(ATG + '/races/' + raceId, {
        headers: { 'Accept': 'application/json' }
      })
      .then(function(res) { return res.ok ? res.json() : null; })
      .catch(function() { return null; });
    });

    const raceResults = await Promise.all(racePromises);

    // 3) Bearbeta lopp
    const races = [];
    for (var i = 0; i < raceResults.length; i++) {
      var rd = raceResults[i];
      if (!rd) continue;
      try {
        races.push(processRace(rd));
      } catch (e) {
        console.log('[V85] Skippar lopp pga fel:', e.message);
      }
    }

    if (!races.length) {
      return reply(500, { error: 'Kunde inte bearbeta någon loppdata.' }, headers);
    }

    // 4) Returnera
    return reply(200, {
      gameId: gameId,
      track: game.tracks && game.tracks[0] ? game.tracks[0].name : (races[0] ? races[0].track : ''),
      date: (gameId.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
      races: races,
      fetchedAt: new Date().toISOString()
    }, headers);

  } catch (err) {
    console.error('[V85] Oväntat fel:', err);
    return reply(500, { error: 'Serverfel: ' + err.message }, headers);
  }
};


// ═══════════════════════════════════════
// PARSE GAME ID
// ═══════════════════════════════════════
function parseGameId(raw) {
  var m;
  // V85_2026-03-09_1
  m = raw.match(/(V8[56]_\d{4}-\d{2}-\d{2}_\d+)/i);
  if (m) return m[1].toUpperCase();
  // V85/2026-03-09/1 (ATG-länk)
  m = raw.match(/V8[56]\/(\d{4}-\d{2}-\d{2})\/(\d+)/i);
  if (m) return 'V85_' + m[1] + '_' + m[2];
  // Lösa varianter
  m = raw.match(/V8[56]\D*(\d{4}-\d{2}-\d{2})\D*(\d+)/i);
  if (m) return 'V85_' + m[1] + '_' + m[2];
  return null;
}


// ═══════════════════════════════════════
// PROCESS RACE
// ═══════════════════════════════════════
function processRace(race) {
  var starts = race.starts || [];
  var horses = [];

  for (var i = 0; i < starts.length; i++) {
    horses.push(processHorse(starts[i], race));
  }

  var insights = calcInsights(horses);
  var scoutAnalysis = buildScoutText(horses, insights, race);
  markPicks(horses, insights);

  return {
    raceNumber: race.number || (i + 1),
    name: race.name || ('Lopp ' + race.number),
    track: race.track ? race.track.name : '',
    distance: race.distance || null,
    startMethod: race.startMethod === 'auto' ? 'auto' : 'volt',
    startTime: race.startTime || race.scheduledStartTime || null,
    scoutAnalysis: scoutAnalysis,
    horses: horses,
    insights: insights
  };
}


// ═══════════════════════════════════════
// PROCESS HORSE
// ═══════════════════════════════════════
function processHorse(start, race) {
  var horse = start.horse || {};
  var driverRaw = start.driver || {};
  var trainerRaw = horse.trainer || start.trainer || {};
  var pools = start.pools || {};

  // Odds – kolla flera pool-typer
  var winOdds = null;
  if (pools.vinnare && pools.vinnare.odds) {
    winOdds = pools.vinnare.odds / 100;
  } else if (pools.V75 && pools.V75.odds) {
    winOdds = pools.V75.odds / 100;
  } else if (pools.V86 && pools.V86.odds) {
    winOdds = pools.V86.odds / 100;
  } else if (pools.V85 && pools.V85.odds) {
    winOdds = pools.V85.odds / 100;
  }
  // ATG ger ibland odds direkt
  if (!winOdds && start.vpOdds) {
    winOdds = start.vpOdds / 100;
  }

  // Form
  var formStr = getFormString(horse);
  var recentStarts = getRecentStarts(horse);
  var times = getTimes(horse);
  var driver = personStats(driverRaw);
  var trainer = personStats(trainerRaw);

  // Value score
  var histPct = histWinPct(horse);
  var implPct = winOdds ? (100 / winOdds) : 0;
  var valueScore = Math.round((histPct - implPct) * 10) / 10;

  // Front runner
  var frScore = frontRunnerScore(start, race);

  // Flags
  var flags = buildFlags(start, horse, driver, trainer, times, formStr, valueScore);

  return {
    nr: start.number,
    name: horse.name || ('Häst ' + start.number),
    winOdds: winOdds,
    postPosition: start.postPosition || start.number,
    history: {
      formStr: formStr,
      avgKmTime10: times.avg,
      bestKmTime: times.best,
      timeTrend: times.trend,
      recentStarts: recentStarts,
      trackStats: trackStats(horse, race.track ? race.track.name : '')
    },
    driver: driver,
    trainer: trainer,
    flags: flags,
    valueScore: valueScore,
    frontRunnerScore: frScore,
    analysis: horse.raceComment || start.raceComment || '',
    scoutPick: false,
    scoutPickType: null
  };
}


// ═══════════════════════════════════════
// FORM STRING
// ═══════════════════════════════════════
function getFormString(horse) {
  // ATG ger ibland formFigures direkt
  if (horse.formFigures) return horse.formFigures.slice(0, 5);

  var results = [];
  if (horse.startSummary && horse.startSummary.lastStarts) {
    results = horse.startSummary.lastStarts;
  } else if (horse.results) {
    results = horse.results;
  }

  var form = '';
  for (var i = 0; i < Math.min(5, results.length); i++) {
    var r = results[i];
    var place = r.place || r.finishOrder || 99;
    if (r.disqualified || r.dq) form += 'D';
    else if (place === 1) form += 'V';
    else if (place <= 3) form += 'P';
    else form += 'U';
  }
  return form || '';
}


// ═══════════════════════════════════════
// RECENT STARTS
// ═══════════════════════════════════════
function getRecentStarts(horse) {
  var starts = [];
  if (horse.startSummary && horse.startSummary.lastStarts) {
    starts = horse.startSummary.lastStarts;
  } else if (horse.results) {
    starts = horse.results;
  }

  var out = [];
  for (var i = 0; i < Math.min(7, starts.length); i++) {
    var s = starts[i];
    out.push({
      date: s.date || s.raceDate || '',
      track: (s.track ? s.track.name : s.trackName) || '',
      distance: s.distance || null,
      place: s.place || s.finishOrder || null,
      disk: s.disqualified || s.dq || false,
      kmTimeRaw: s.kmTime || s.kilometerTime || '',
      odds: s.odds ? s.odds / 100 : null
    });
  }
  return out;
}


// ═══════════════════════════════════════
// KM TIMES
// ═══════════════════════════════════════
function getTimes(horse) {
  var starts = [];
  if (horse.startSummary && horse.startSummary.lastStarts) starts = horse.startSummary.lastStarts;
  else if (horse.results) starts = horse.results;

  var times = [];
  for (var i = 0; i < Math.min(10, starts.length); i++) {
    var raw = starts[i].kmTime || starts[i].kilometerTime;
    if (raw) {
      var secs = parseKmTime(raw);
      if (secs > 50 && secs < 100) times.push(secs);
    }
  }

  // Fallback: records
  if (!times.length) {
    var rec = horse.records || {};
    var best = rec.bestAutoTime || rec.bestVoltTime;
    if (best) {
      var s = parseKmTime(best);
      if (s > 50 && s < 100) return { avg: s, best: s, trend: 'stable' };
    }
    return { avg: null, best: null, trend: 'stable' };
  }

  var sum = 0;
  for (var j = 0; j < times.length; j++) sum += times[j];
  var avg = sum / times.length;
  var best = Math.min.apply(null, times);

  // Trend
  var trend = 'stable';
  if (times.length >= 4) {
    var half = Math.floor(times.length / 2);
    var sumR = 0, sumO = 0;
    for (var k = 0; k < half; k++) sumR += times[k];
    for (var k2 = half; k2 < times.length; k2++) sumO += times[k2];
    var recent = sumR / half;
    var older = sumO / (times.length - half);
    if (recent < older - 0.5) trend = 'improving';
    else if (recent > older + 0.5) trend = 'declining';
  }

  return {
    avg: Math.round(avg * 10) / 10,
    best: Math.round(best * 10) / 10,
    trend: trend
  };
}

function parseKmTime(raw) {
  if (typeof raw === 'number') return raw;
  var str = String(raw).replace(',', '.').replace(':', '.');
  var parts = str.split('.');
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + parseFloat('0.' + parts[2]);
  }
  var val = parseFloat(str);
  if (val < 3) return val * 60;
  return val;
}


// ═══════════════════════════════════════
// PERSON STATS
// ═══════════════════════════════════════
function personStats(person) {
  if (!person) return { name: '', yearPct: 0, form30: null, form14: null, inForm: false };

  var first = person.firstName || '';
  var last = person.lastName || '';
  var name = (first + ' ' + last).trim() || '';

  var stats = person.statistics || person.stats || {};
  var yearStarts = stats.starts || 0;
  var yearWins = stats.wins || stats.firsts || 0;

  // ATG ger ibland thisYear
  if (!yearStarts && stats.thisYear) {
    yearStarts = stats.thisYear.starts || 0;
    yearWins = stats.thisYear.wins || stats.thisYear.firsts || 0;
  }

  var yearPct = yearStarts > 0 ? Math.round(yearWins / yearStarts * 100) : 0;

  // Uppskatta 30-dagars
  var s30 = Math.max(1, Math.round(yearStarts / 12));
  var w30 = Math.round(yearWins / 12);
  var pct30 = s30 > 0 ? Math.round(w30 / s30 * 100) : yearPct;

  // ATG ger ibland last30
  if (stats.last30Days) {
    s30 = stats.last30Days.starts || s30;
    w30 = stats.last30Days.wins || w30;
    pct30 = s30 > 0 ? Math.round(w30 / s30 * 100) : pct30;
  }

  var s14 = Math.max(1, Math.round(s30 / 2));
  var w14 = Math.round(w30 / 2);
  var pct14 = s14 > 0 ? Math.round(w14 / s14 * 100) : pct30;

  return {
    name: name,
    yearPct: yearPct,
    form30: { starts: s30, wins: w30, winPct: pct30 },
    form14: { starts: s14, wins: w14, winPct: pct14 },
    inForm: pct30 >= 18
  };
}


// ═══════════════════════════════════════
// TRACK STATS
// ═══════════════════════════════════════
function trackStats(horse, currentTrack) {
  var starts = [];
  if (horse.startSummary && horse.startSummary.lastStarts) starts = horse.startSummary.lastStarts;
  else if (horse.results) starts = horse.results;

  var map = {};
  for (var i = 0; i < starts.length; i++) {
    var tn = starts[i].track ? starts[i].track.name : starts[i].trackName;
    if (!tn) continue;
    if (!map[tn]) map[tn] = { track: tn, starts: 0, wins: 0 };
    map[tn].starts++;
    if ((starts[i].place || starts[i].finishOrder) === 1) map[tn].wins++;
  }

  var arr = [];
  for (var key in map) {
    map[key].winPct = map[key].starts > 0 ? Math.round(map[key].wins / map[key].starts * 100) : 0;
    arr.push(map[key]);
  }

  arr.sort(function(a, b) {
    if (a.track === currentTrack) return -1;
    if (b.track === currentTrack) return 1;
    return b.starts - a.starts;
  });

  return arr.slice(0, 5);
}


// ═══════════════════════════════════════
// HIST WIN PCT
// ═══════════════════════════════════════
function histWinPct(horse) {
  var summary = horse.startSummary || {};
  var starts = summary.starts || 0;
  var wins = summary.wins || summary.firsts || 0;
  if (starts > 0) return Math.round(wins / starts * 100);

  // Fallback
  var results = (summary.lastStarts || horse.results || []);
  if (!results.length) return 0;
  var w = 0;
  for (var i = 0; i < results.length; i++) {
    if ((results[i].place || results[i].finishOrder) === 1) w++;
  }
  return Math.round(w / results.length * 100);
}


// ═══════════════════════════════════════
// FRONT RUNNER SCORE
// ═══════════════════════════════════════
function frontRunnerScore(start, race) {
  var score = 0;
  var pos = start.postPosition || start.number;

  if (race.startMethod === 'auto') {
    if (pos <= 2) score += 4;
    else if (pos <= 4) score += 2;
  } else {
    if (pos === 1) score += 5;
    else if (pos === 2) score += 3;
    else if (pos <= 4) score += 1;
  }

  var form = getFormString(start.horse || {});
  var vCount = (form.match(/V/g) || []).length;
  score += vCount;

  return Math.min(10, score);
}


// ═══════════════════════════════════════
// FLAGS
// ═══════════════════════════════════════
function buildFlags(start, horse, driver, trainer, times, formStr, valueScore) {
  var flags = [];
  var vCount = (formStr.match(/V/g) || []).length;

  if (vCount >= 2) flags.push('🔥 Form-häst – ' + vCount + 'V senaste ' + formStr.length);
  if ((start.postPosition || start.number) <= 2) flags.push('🏃 Spetshäst – spår ' + (start.postPosition || start.number));
  if (times.trend === 'improving') flags.push('📈 Förbättrade km-tider');
  if (driver.form30 && driver.form30.winPct >= 18) flags.push('🎯 Kusk i form ' + driver.form30.winPct + '%');
  if (driver.form30 && driver.form30.winPct > 0 && driver.form30.winPct < 8) flags.push('⚠️ Kusk i svag form');
  if (formStr[0] === 'V') flags.push('⚡ Vann senast');
  if (valueScore > 10) flags.push('💎 Kraftigt undervärderad');
  if (start.driverChanged) flags.push('🔄 Kuskbyte');

  return flags.slice(0, 4);
}


// ═══════════════════════════════════════
// INSIGHTS
// ═══════════════════════════════════════
function calcInsights(horses) {
  // Front runner
  var byFR = horses.slice().sort(function(a, b) { return b.frontRunnerScore - a.frontRunnerScore; });
  var likelyFrontRunner = null;
  if (byFR.length && byFR[0].frontRunnerScore >= 3) {
    likelyFrontRunner = {
      nr: byFR[0].nr,
      name: byFR[0].name,
      score: byFR[0].frontRunnerScore,
      reason: frReason(byFR[0])
    };
  }

  // Value horse
  var byVal = horses.filter(function(h) { return h.valueScore > 4; })
    .sort(function(a, b) { return b.valueScore - a.valueScore; });
  var topValueHorse = null;
  if (byVal.length) {
    var form = byVal[0].history ? byVal[0].history.formStr : '';
    var total = form.length || 1;
    var wins = (form.match(/V/g) || []).length;
    topValueHorse = {
      nr: byVal[0].nr,
      name: byVal[0].name,
      valueScore: byVal[0].valueScore,
      odds: byVal[0].winOdds,
      histWinPct: Math.round(wins / total * 100)
    };
  }

  // Missed horses
  var missed = horses.filter(function(h) { return h.valueScore > 6 && h.winOdds > 5; })
    .sort(function(a, b) { return b.valueScore - a.valueScore; })
    .slice(0, 2)
    .map(function(h) {
      return {
        nr: h.nr,
        name: h.name,
        odds: h.winOdds,
        valueScore: h.valueScore,
        reason: h.flags.slice(0, 2).join(' · ') || 'Undervärderad'
      };
    });

  return {
    likelyFrontRunner: likelyFrontRunner,
    topValueHorse: topValueHorse,
    missedHorses: missed,
    formHorses: []
  };
}

function frReason(h) {
  var parts = [];
  if (h.postPosition <= 2) parts.push('Spår ' + h.postPosition);
  var hasForm = false;
  for (var i = 0; i < h.flags.length; i++) {
    if (h.flags[i].indexOf('Form') !== -1) hasForm = true;
  }
  if (hasForm) parts.push('Topform');
  return parts.join(' · ') || 'Stark position';
}


// ═══════════════════════════════════════
// SCOUT TEXT
// ═══════════════════════════════════════
function buildScoutText(horses, insights, race) {
  var parts = [];
  var fr = insights.likelyFrontRunner;
  var tv = insights.topValueHorse;

  if (fr) {
    var frH = horses.find(function(h) { return h.nr === fr.nr; });
    if (frH) {
      var sm = race.startMethod === 'auto' ? 'autostart' : 'voltstart';
      var dn = frH.driver ? frH.driver.name : '';
      parts.push(frH.name + ' (' + frH.nr + ') ser ut att ta spets från ' + sm + (dn ? ' med ' + dn : '') + '.');
    }
  }

  if (tv && (!fr || tv.nr !== fr.nr)) {
    var tvH = horses.find(function(h) { return h.nr === tv.nr; });
    if (tvH) {
      parts.push(tvH.name + ' (' + tvH.nr + ') sticker ut som värdehäst på odds ' + tvH.winOdds + ' (EV +' + tv.valueScore + '%).');
    }
  }

  var missed = insights.missedHorses || [];
  if (missed.length && (!fr || missed[0].nr !== fr.nr) && (!tv || missed[0].nr !== tv.nr)) {
    parts.push('Håll koll på ' + missed[0].name + ' @ ' + missed[0].odds + ' – ' + missed[0].reason + '.');
  }

  // Loppkaraktär
  var sorted = horses.filter(function(h) { return h.winOdds; }).sort(function(a, b) { return a.winOdds - b.winOdds; });
  if (sorted.length >= 2 && sorted[0].winOdds < 2.5) {
    parts.push('Tydlig favorit – potentiellt singelläge.');
  } else if (sorted.length >= 2 && sorted[0].winOdds > 4) {
    parts.push('Öppet lopp – gardering rekommenderas.');
  }

  return parts.join(' ') || 'Jämnt lopp utan tydlig favorit.';
}


// ═══════════════════════════════════════
// SCOUT PICKS
// ═══════════════════════════════════════
function markPicks(horses, insights) {
  var scored = horses.map(function(h) {
    var form = h.history ? h.history.formStr : '';
    var vCount = (form.match(/V/g) || []).length;
    return {
      h: h,
      score: (h.valueScore || 0) * 0.4
           + (h.frontRunnerScore || 0) * 3
           + vCount * 5
           + (h.driver && h.driver.inForm ? 5 : 0)
           + (h.trainer && h.trainer.inForm ? 3 : 0)
           + (h.history && h.history.timeTrend === 'improving' ? 4 : 0)
    };
  }).sort(function(a, b) { return b.score - a.score; });

  if (!scored.length) return;

  var gap = scored.length >= 2 ? scored[0].score - scored[1].score : 999;

  if (gap > 8) {
    scored[0].h.scoutPick = true;
    scored[0].h.scoutPickType = 'singel';
  } else {
    scored[0].h.scoutPick = true;
    scored[0].h.scoutPickType = 'gardering';
    if (scored.length >= 2) {
      scored[1].h.scoutPick = true;
      scored[1].h.scoutPickType = 'gardering';
    }
  }
}


// ═══════════════════════════════════════
// REPLY HELPER
// ═══════════════════════════════════════
function reply(code, body, headers) {
  return {
    statusCode: code,
    headers: headers,
    body: JSON.stringify(body)
  };
}
