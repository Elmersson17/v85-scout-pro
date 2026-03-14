// V85 Scout Pro – Netlify Serverless Function
// Hämtar data från ATG:s publika API, beräknar analyser och returnerar JSON
// Inga externa dependencies – använder Node 18 inbyggd fetch

const ATG = 'https://www.atg.se/services/racinginfo/v1/api';

exports.handler = async function(event, context) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  try {
    var raw = (event.queryStringParameters || {}).game || '';
    if (!raw.trim()) {
      return reply(400, { error: 'Ange ett spel-ID, t.ex. V85_2026-03-15 eller bara ett datum som 2026-03-15' }, headers);
    }

    raw = raw.trim();

    // Steg 1: Hitta ratt game ID
    var gameId = await resolveGameId(raw);
    if (!gameId) {
      return reply(404, { error: 'Kunde inte hitta V85-spel for: ' + raw + '. Testa med ett lordagsdatum.' }, headers);
    }

    console.log('[V85] Resolved game ID:', gameId);

    // Steg 2: Hamta spelinfo
    var gameData = await apiFetch(ATG + '/games/' + gameId);
    if (!gameData || (!gameData.races && !gameData.tracks)) {
      return reply(404, { error: 'Hittade inget spel med ID: ' + gameId }, headers);
    }

    // Steg 3: Hamta varje lopp parallellt
    var raceIds = (gameData.races || []).map(function(r) { return r.id || r.raceId; }).filter(Boolean);

    if (!raceIds.length) {
      return reply(404, { error: 'Spelet har inga lopp annu.' }, headers);
    }

    var racePromises = raceIds.map(function(id) {
      return apiFetch(ATG + '/races/' + id).catch(function() { return null; });
    });
    var raceResults = await Promise.all(racePromises);

    // Steg 4: Bearbeta lopp
    var races = [];
    for (var i = 0; i < raceResults.length; i++) {
      if (!raceResults[i]) continue;
      try {
        races.push(processRace(raceResults[i]));
      } catch (e) {
        console.log('[V85] Skippar lopp:', e.message);
      }
    }

    if (!races.length) {
      return reply(500, { error: 'Kunde inte bearbeta loppdata.' }, headers);
    }

    // Steg 5: Returnera
    var trackName = '';
    if (gameData.tracks && gameData.tracks.length) trackName = gameData.tracks[0].name || '';
    if (!trackName && races.length) trackName = races[0].track || '';

    return reply(200, {
      gameId: gameId,
      track: trackName,
      date: extractDate(gameId),
      races: races,
      fetchedAt: new Date().toISOString()
    }, headers);

  } catch (err) {
    console.error('[V85] Error:', err);
    return reply(500, { error: 'Serverfel: ' + err.message }, headers);
  }
};

async function resolveGameId(raw) {
  // Om det redan ar ett komplett game-ID med track-nummer
  var full = raw.match(/(V8[56]_\d{4}-\d{2}-\d{2}_\d+_\d+)/i);
  if (full) return full[1];

  // Extrahera datum
  var dateMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) {
    // Bara "V85" - hamta nasta/senaste
    try {
      var product = await apiFetch(ATG + '/products/V85');
      if (product && product.currentGame) return product.currentGame.id;
      if (product && product.nextGame) return product.nextGame.id;
    } catch (e) {}
    return null;
  }

  var date = dateMatch[1];

  // Prova calendar-API for att hitta ratt game-ID
  try {
    var calUrl = ATG + '/calendar/day/' + date;
    console.log('[V85] Calendar:', calUrl);
    var cal = await apiFetch(calUrl);

    if (cal && cal.games) {
      var v85games = cal.games.V85 || cal.games.v85 || [];
      if (v85games.length > 0) {
        return v85games[0].id || v85games[0];
      }
      for (var key in cal.games) {
        if (key.toUpperCase().indexOf('V85') !== -1) {
          var arr = cal.games[key];
          if (Array.isArray(arr) && arr.length > 0) {
            return arr[0].id || arr[0];
          }
        }
      }
    }

    if (cal && cal.tracks) {
      for (var t = 0; t < cal.tracks.length; t++) {
        var track = cal.tracks[t];
        var tGames = track.games || [];
        for (var g = 0; g < tGames.length; g++) {
          var gid = tGames[g].id || '';
          if (gid.toUpperCase().indexOf('V85') !== -1) {
            return gid;
          }
        }
      }
    }
  } catch (e) {
    console.log('[V85] Calendar fetch failed:', e.message);
  }

  // Prova products-endpointen
  try {
    var prod = await apiFetch(ATG + '/products/V85');
    if (prod) {
      if (prod.currentGame && prod.currentGame.id && prod.currentGame.id.indexOf(date) !== -1) {
        return prod.currentGame.id;
      }
      if (prod.nextGame && prod.nextGame.id && prod.nextGame.id.indexOf(date) !== -1) {
        return prod.nextGame.id;
      }
      if (prod.currentGame && prod.currentGame.id) {
        return prod.currentGame.id;
      }
    }
  } catch (e) {
    console.log('[V85] Products fetch failed:', e.message);
  }

  // Sista fallback: testa vanliga ID-format direkt
  var formats = ['V85_' + date + '_1', 'V85_' + date + '_1_1'];
  for (var f = 0; f < formats.length; f++) {
    try {
      var test = await fetch(ATG + '/games/' + formats[f], {
        headers: { 'Accept': 'application/json' }
      });
      if (test.ok) return formats[f];
    } catch (e) {}
  }

  return null;
}

async function apiFetch(url) {
  console.log('[V85] GET', url);
  var res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) {
    throw new Error('ATG ' + res.status + ' ' + res.statusText + ' for ' + url);
  }
  return res.json();
}

function extractDate(gameId) {
  var m = (gameId || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function processRace(race) {
  var starts = race.starts || [];
  var horses = [];

  for (var i = 0; i < starts.length; i++) {
    try {
      horses.push(processHorse(starts[i], race));
    } catch (e) {
      console.log('[V85] Skippar hast:', e.message);
    }
  }

  var insights = calcInsights(horses);
  var scoutAnalysis = buildScoutText(horses, insights, race);
  markPicks(horses);

  return {
    raceNumber: race.number || 0,
    name: race.name || ('Lopp ' + (race.number || '?')),
    track: race.track ? (race.track.name || '') : '',
    distance: race.distance || null,
    startMethod: race.startMethod === 'auto' ? 'auto' : 'volt',
    startTime: race.startTime || race.scheduledStartTime || null,
    scoutAnalysis: scoutAnalysis,
    horses: horses,
    insights: insights
  };
}

function processHorse(start, race) {
  var horse = start.horse || {};
  var driverRaw = start.driver || {};
  var trainerRaw = horse.trainer || start.trainer || {};
  var pools = start.pools || {};

  var winOdds = null;
  var poolKeys = ['vinnare', 'V85', 'V75', 'V86', 'V65', 'V64', 'V4', 'V3'];
  for (var p = 0; p < poolKeys.length; p++) {
    var pool = pools[poolKeys[p]];
    if (pool && pool.odds) {
      winOdds = pool.odds / 100;
      break;
    }
  }
  if (!winOdds && start.vpOdds) winOdds = start.vpOdds / 100;

  var formStr = getFormString(horse);
  var recentStarts = getRecentStarts(horse);
  var times = getTimes(horse);
  var driver = personStats(driverRaw);
  var trainer = personStats(trainerRaw);

  var histPct = histWinPct(horse);
  var implPct = winOdds ? (100 / winOdds) : 0;
  var valueScore = Math.round((histPct - implPct) * 10) / 10;

  var frScore = frontRunnerScore(start, race);
  var flags = buildFlags(start, horse, driver, trainer, times, formStr, valueScore);

  return {
    nr: start.number,
    name: horse.name || ('Hast ' + start.number),
    winOdds: winOdds,
    postPosition: start.postPosition || start.number,
    history: {
      formStr: formStr,
      avgKmTime10: times.avg,
      bestKmTime: times.best,
      timeTrend: times.trend,
      recentStarts: recentStarts,
      trackStats: getTrackStats(horse, race.track ? race.track.name : '')
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

function getFormString(horse) {
  if (horse.formFigures) return horse.formFigures.slice(0, 5);
  var results = [];
  if (horse.startSummary && horse.startSummary.lastStarts) results = horse.startSummary.lastStarts;
  else if (horse.results) results = horse.results;
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

function getRecentStarts(horse) {
  var starts = [];
  if (horse.startSummary && horse.startSummary.lastStarts) starts = horse.startSummary.lastStarts;
  else if (horse.results) starts = horse.results;
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
  return { avg: Math.round(avg * 10) / 10, best: Math.round(best * 10) / 10, trend: trend };
}

function parseKmTime(raw) {
  if (typeof raw === 'number') return raw;
  var str = String(raw).replace(',', '.').replace(':', '.');
  var parts = str.split('.');
  if (parts.length === 3) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + parseFloat('0.' + parts[2]);
  var val = parseFloat(str);
  if (val < 3) return val * 60;
  return val;
}

function personStats(person) {
  if (!person) return { name: '', yearPct: 0, form30: null, form14: null, inForm: false };
  var first = person.firstName || '';
  var last = person.lastName || '';
  var name = (first + ' ' + last).trim() || '';
  var stats = person.statistics || person.stats || {};
  var yearStarts = stats.starts || 0;
  var yearWins = stats.wins || stats.firsts || 0;
  if (!yearStarts && stats.thisYear) {
    yearStarts = stats.thisYear.starts || 0;
    yearWins = stats.thisYear.wins || stats.thisYear.firsts || 0;
  }
  var yearPct = yearStarts > 0 ? Math.round(yearWins / yearStarts * 100) : 0;
  var s30 = Math.max(1, Math.round(yearStarts / 12));
  var w30 = Math.round(yearWins / 12);
  var pct30 = s30 > 0 ? Math.round(w30 / s30 * 100) : yearPct;
  if (stats.last30Days) {
    s30 = stats.last30Days.starts || s30;
    w30 = stats.last30Days.wins || w30;
    pct30 = s30 > 0 ? Math.round(w30 / s30 * 100) : pct30;
  }
  var s14 = Math.max(1, Math.round(s30 / 2));
  var w14 = Math.round(w30 / 2);
  var pct14 = s14 > 0 ? Math.round(w14 / s14 * 100) : pct30;
  return { name: name, yearPct: yearPct, form30: { starts: s30, wins: w30, winPct: pct30 }, form14: { starts: s14, wins: w14, winPct: pct14 }, inForm: pct30 >= 18 };
}

function getTrackStats(horse, currentTrack) {
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

function histWinPct(horse) {
  var summary = horse.startSummary || {};
  var starts = summary.starts || 0;
  var wins = summary.wins || summary.firsts || 0;
  if (starts > 0) return Math.round(wins / starts * 100);
  var results = (summary.lastStarts || horse.results || []);
  if (!results.length) return 0;
  var w = 0;
  for (var i = 0; i < results.length; i++) {
    if ((results[i].place || results[i].finishOrder) === 1) w++;
  }
  return Math.round(w / results.length * 100);
}

function frontRunnerScore(start, race) {
  var score = 0;
  var pos = start.postPosition || start.number;
  if (race.startMethod === 'auto') {
    if (pos <= 2) score += 4; else if (pos <= 4) score += 2;
  } else {
    if (pos === 1) score += 5; else if (pos === 2) score += 3; else if (pos <= 4) score += 1;
  }
  var form = getFormString(start.horse || {});
  var vCount = (form.match(/V/g) || []).length;
  score += vCount;
  return Math.min(10, score);
}

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

function calcInsights(horses) {
  var byFR = horses.slice().sort(function(a, b) { return b.frontRunnerScore - a.frontRunnerScore; });
  var likelyFrontRunner = null;
  if (byFR.length && byFR[0].frontRunnerScore >= 3) {
    likelyFrontRunner = { nr: byFR[0].nr, name: byFR[0].name, score: byFR[0].frontRunnerScore, reason: frReason(byFR[0]) };
  }
  var byVal = horses.filter(function(h) { return h.valueScore > 4; }).sort(function(a, b) { return b.valueScore - a.valueScore; });
  var topValueHorse = null;
  if (byVal.length) {
    var form = byVal[0].history ? byVal[0].history.formStr : '';
    var total = form.length || 1;
    var wins = (form.match(/V/g) || []).length;
    topValueHorse = { nr: byVal[0].nr, name: byVal[0].name, valueScore: byVal[0].valueScore, odds: byVal[0].winOdds, histWinPct: Math.round(wins / total * 100) };
  }
  var missed = horses.filter(function(h) { return h.valueScore > 6 && h.winOdds > 5; }).sort(function(a, b) { return b.valueScore - a.valueScore; }).slice(0, 2).map(function(h) {
    return { nr: h.nr, name: h.name, odds: h.winOdds, valueScore: h.valueScore, reason: h.flags.slice(0, 2).join(' · ') || 'Undervärderad' };
  });
  return { likelyFrontRunner: likelyFrontRunner, topValueHorse: topValueHorse, missedHorses: missed, formHorses: [] };
}

function frReason(h) {
  var parts = [];
  if (h.postPosition <= 2) parts.push('Spår ' + h.postPosition);
  var hasForm = false;
  for (var i = 0; i < h.flags.length; i++) { if (h.flags[i].indexOf('Form') !== -1) hasForm = true; }
  if (hasForm) parts.push('Topform');
  return parts.join(' · ') || 'Stark position';
}

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
    if (tvH) parts.push(tvH.name + ' (' + tvH.nr + ') sticker ut som värdehäst på odds ' + tvH.winOdds + ' (EV +' + tv.valueScore + '%).');
  }
  var missed2 = insights.missedHorses || [];
  if (missed2.length && (!fr || missed2[0].nr !== fr.nr) && (!tv || missed2[0].nr !== tv.nr)) {
    parts.push('Håll koll på ' + missed2[0].name + ' @ ' + missed2[0].odds + ' – ' + missed2[0].reason + '.');
  }
  var sorted = horses.filter(function(h) { return h.winOdds; }).sort(function(a, b) { return a.winOdds - b.winOdds; });
  if (sorted.length >= 2 && sorted[0].winOdds < 2.5) parts.push('Tydlig favorit – potentiellt singelläge.');
  else if (sorted.length >= 2 && sorted[0].winOdds > 4) parts.push('Öppet lopp – gardering rekommenderas.');
  return parts.join(' ') || 'Jämnt lopp utan tydlig favorit.';
}

function markPicks(horses) {
  var scored = horses.map(function(h) {
    var form = h.history ? h.history.formStr : '';
    var vCount = (form.match(/V/g) || []).length;
    return { h: h, score: (h.valueScore || 0) * 0.4 + (h.frontRunnerScore || 0) * 3 + vCount * 5 + (h.driver && h.driver.inForm ? 5 : 0) + (h.trainer && h.trainer.inForm ? 3 : 0) + (h.history && h.history.timeTrend === 'improving' ? 4 : 0) };
  }).sort(function(a, b) { return b.score - a.score; });
  if (!scored.length) return;
  var gap = scored.length >= 2 ? scored[0].score - scored[1].score : 999;
  if (gap > 8) { scored[0].h.scoutPick = true; scored[0].h.scoutPickType = 'singel'; }
  else { scored[0].h.scoutPick = true; scored[0].h.scoutPickType = 'gardering'; if (scored.length >= 2) { scored[1].h.scoutPick = true; scored[1].h.scoutPickType = 'gardering'; } }
}

function reply(code, body, headers) {
  return { statusCode: code, headers: headers, body: JSON.stringify(body) };
}
