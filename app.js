/* Lógica pura (testeable con node) + UI */
(function (root) {
  'use strict';

  // ---------- Lógica ----------
  function moneyToNumber(m) {
    if (!m) return 0;
    return Number(m.units || 0) + Number(m.nanos || 0) / 1e9;
  }

  // Devuelve { amount, known, currency } a partir del tollInfo de la Routes API
  function parseTolls(route, currency) {
    var ti = route && route.travelAdvisory && route.travelAdvisory.tollInfo;
    if (!ti) return { amount: 0, known: true, hasToll: false };
    var prices = ti.estimatedPrice || [];
    if (!prices.length) return { amount: 0, known: false, hasToll: true };
    var p = prices.find(function (x) { return x.currencyCode === currency; }) || prices[0];
    return { amount: moneyToNumber(p), known: true, hasToll: true, currency: p.currencyCode };
  }

  function parseDurationSeconds(d) {
    if (!d) return 0;
    return Math.round(parseFloat(String(d).replace('s', '')) || 0);
  }

  function computeQuote(opts) {
    var km = opts.distanceMeters / 1000;
    if (opts.roundTrip) km *= 2;
    var tollMult = opts.roundTrip ? 2 : 1;
    var kmCost = km * opts.pricePerKm;
    var tolls = (opts.tollAmount + (opts.manualTolls || 0)) * tollMult;
    return {
      km: km,
      kmCost: kmCost,
      tolls: tolls,
      total: kmCost + tolls
    };
  }

  // Espera: se cobra por minuto iniciado, después de los minutos de gracia
  function computeWait(waitMs, graceMin, pricePerMin) {
    var totalMin = waitMs / 60000;
    var billable = Math.max(0, totalMin - (graceMin || 0));
    var billableMin = Math.max(0, Math.ceil(billable - 1e-9)) + 0; // evita -0
    return { totalMin: totalMin, billableMin: billableMin, cost: billableMin * (pricePerMin || 0) };
  }
  function tripWaitMs(trip, now) {
    return (trip.waitMs || 0) + (trip.waitingSince ? Math.max(0, now - trip.waitingSince) : 0);
  }
  function tripTotals(trip, now) {
    var w = computeWait(tripWaitMs(trip, now), trip.grace, trip.waitPrice);
    var extras = (trip.extras || []).reduce(function (a, b) { return a + b; }, 0);
    return {
      wait: w, extras: extras,
      total: trip.kmCost + trip.tolls + extras + w.cost
    };
  }
  function fmtDur(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  // 'Hoy' / 'Mañana' / 'Vencida' / '' según la fecha de la reserva
  function dayLabel(iso, now) {
    var d = new Date(iso), n = new Date(now == null ? Date.now() : now);
    var sd = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((sd(d) - sd(n)) / 86400000);
    return diff === 0 ? 'Hoy' : diff === 1 ? 'Mañana' : diff < 0 ? 'Vencida' : '';
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function icsDate(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  function buildICS(r) {
    var start = new Date(r.startISO);
    var end = new Date(start.getTime() + Math.max(r.durationSec, 1800) * 1000);
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cotizador de Viajes//ES', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + r.id + '@cotizador',
      'DTSTAMP:' + icsDate(new Date()),
      'DTSTART:' + icsDate(start),
      'DTEND:' + icsDate(end),
      'SUMMARY:' + icsEscape(r.title),
      'LOCATION:' + icsEscape(r.stops[0]),
      'DESCRIPTION:' + icsEscape(r.description),
      'END:VEVENT', 'END:VCALENDAR'
    ];
    return lines.join('\r\n');
  }

  function googleCalendarURL(r) {
    var start = new Date(r.startISO);
    var end = new Date(start.getTime() + Math.max(r.durationSec, 1800) * 1000);
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
      '&text=' + encodeURIComponent(r.title) +
      '&dates=' + icsDate(start) + '/' + icsDate(end) +
      '&details=' + encodeURIComponent(r.description) +
      '&location=' + encodeURIComponent(r.stops[0]);
  }

  function mapsURL(stops) {
    var u = 'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
      '&origin=' + encodeURIComponent(stops[0]) +
      '&destination=' + encodeURIComponent(stops[stops.length - 1]);
    if (stops.length > 2) {
      u += '&waypoints=' + encodeURIComponent(stops.slice(1, -1).join('|'));
    }
    return u;
  }

  function buildRoutesRequest(stops, emissionType) {
    var wp = function (a) { return { address: a }; };
    var body = {
      origin: wp(stops[0]),
      destination: wp(stops[stops.length - 1]),
      travelMode: 'DRIVE',
      extraComputations: ['TOLLS'],
      routeModifiers: { vehicleInfo: { emissionType: emissionType || 'GASOLINE' } },
      regionCode: 'AR',
      languageCode: 'es-419',
      units: 'METRIC'
    };
    if (stops.length > 2) body.intermediates = stops.slice(1, -1).map(wp);
    return body;
  }

  var api = {
    moneyToNumber: moneyToNumber, parseTolls: parseTolls, parseDurationSeconds: parseDurationSeconds,
    computeQuote: computeQuote, buildICS: buildICS, googleCalendarURL: googleCalendarURL,
    mapsURL: mapsURL, buildRoutesRequest: buildRoutesRequest,
    computeWait: computeWait, tripWaitMs: tripWaitMs, tripTotals: tripTotals, fmtDur: fmtDur,
    dayLabel: dayLabel
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.Cotizador = api;

  // ---------- UI ----------
  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var fmt = function (n, cur) {
    try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur || 'ARS' }).format(n); }
    catch (e) { return '$ ' + n.toFixed(2); }
  };

  var state = { lastQuote: null };

  function addStopInput(value) {
    var wrap = $('stops');
    var row = document.createElement('div');
    row.className = 'stop';
    var input = document.createElement('input');
    input.type = 'text'; input.setAttribute('list', 'sugg'); input.autocomplete = 'off';
    input.value = value || '';
    input.addEventListener('input', onSuggest);
    var del = document.createElement('button');
    del.type = 'button'; del.className = 'icon'; del.textContent = '✕'; del.title = 'Quitar';
    del.addEventListener('click', function () { if ($('stops').children.length > 2) { row.remove(); relabel(); } });
    row.appendChild(input); row.appendChild(del);
    wrap.appendChild(row);
    relabel();
  }
  function relabel() {
    var rows = $('stops').children;
    for (var i = 0; i < rows.length; i++) {
      var inp = rows[i].querySelector('input');
      inp.placeholder = i === 0 ? 'Origen' : (i === rows.length - 1 ? 'Destino' : 'Parada ' + i);
    }
  }
  function getStops() {
    return Array.prototype.map.call($('stops').querySelectorAll('input'), function (i) { return i.value.trim(); })
      .filter(Boolean);
  }

  var suggTimer = null;
  function onSuggest(e) {
    var q = e.target.value.trim(), key = $('apiKey').value.trim();
    clearTimeout(suggTimer);
    if (q.length < 3 || !key) return;
    suggTimer = setTimeout(function () {
      fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
        body: JSON.stringify({ input: q, includedRegionCodes: ['ar'], languageCode: 'es' })
      }).then(function (r) { return r.json(); }).then(function (j) {
        var dl = $('sugg'); dl.innerHTML = '';
        (j.suggestions || []).forEach(function (s) {
          var o = document.createElement('option');
          o.value = s.placePrediction && s.placePrediction.text && s.placePrediction.text.text;
          if (o.value) dl.appendChild(o);
        });
      }).catch(function () {});
    }, 350);
  }

  function showError(msg) { var e = $('error'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

  function calculate() {
    showError('');
    var key = $('apiKey').value.trim();
    var stops = getStops();
    var price = parseFloat($('pricePerKm').value);
    if (!key) return showError('Pegá tu API key de Google Maps en Ajustes.');
    if (stops.length < 2) return showError('Ingresá al menos origen y destino.');
    if (!(price >= 0)) return showError('Ingresá un precio por km válido.');
    LS.set('apiKey', key); LS.set('pricePerKm', price); LS.set('emission', $('emission').value);

    $('calc').disabled = true; $('calc').textContent = 'Calculando…';
    fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo,routes.legs.distanceMeters'
      },
      body: JSON.stringify(buildRoutesRequest(stops, $('emission').value))
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j.error && res.j.error.message) || 'Error de la API');
        var route = res.j.routes && res.j.routes[0];
        if (!route) throw new Error('No se encontró una ruta entre esas direcciones.');
        var tolls = parseTolls(route, 'ARS');
        state.route = route; state.tolls = tolls; state.stops = stops;
        renderQuote();
      })
      .catch(function (e) { showError(e.message); })
      .then(function () { $('calc').disabled = false; $('calc').textContent = 'Calcular'; });
  }

  function renderQuote() {
    if (!state.route) return;
    var price = parseFloat($('pricePerKm').value) || 0;
    var manual = parseFloat($('manualToll').value) || 0;
    var q = computeQuote({
      distanceMeters: state.route.distanceMeters, pricePerKm: price,
      tollAmount: state.tolls.amount, manualTolls: manual, roundTrip: $('roundTrip').checked
    });
    state.lastQuote = q;
    var mins = Math.round(parseDurationSeconds(state.route.duration) / 60 * ($('roundTrip').checked ? 2 : 1));
    var html = '<div class="row"><span>Distancia</span><b>' + q.km.toFixed(1) + ' km</b></div>' +
      '<div class="row"><span>Tiempo estimado</span><b>' + Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min</b></div>' +
      '<div class="row"><span>' + q.km.toFixed(1) + ' km × ' + fmt(price) + '</span><b>' + fmt(q.kmCost) + '</b></div>' +
      '<div class="row"><span>Peajes' + (state.tolls.hasToll && !state.tolls.known ? ' (sin tarifa, cargá manual)' : '') +
      '</span><b>' + fmt(q.tolls) + '</b></div>' +
      '<div class="row total"><span>TOTAL</span><b>' + fmt(q.total) + '</b></div>';
    $('quote').innerHTML = html;
    $('result').style.display = 'block';
    $('manualWrap').style.display = state.tolls.hasToll && !state.tolls.known ? 'block' : 'none';
    $('mapsLink').href = mapsURL(state.stops);
  }

  function buildReservation() {
    var when = $('when').value;
    if (!when) { showError('Elegí fecha y hora de la reserva.'); return null; }
    if (!state.lastQuote) { showError('Primero calculá el viaje.'); return null; }
    showError('');
    var q = state.lastQuote, s = state.stops, client = $('client').value.trim();
    var secs = parseDurationSeconds(state.route.duration) * ($('roundTrip').checked ? 2 : 1);
    var desc = 'Cliente: ' + (client || '-') + '\n' +
      'Recorrido: ' + s.join(' → ') + ($('roundTrip').checked ? ' (ida y vuelta)' : '') + '\n' +
      'Distancia: ' + q.km.toFixed(1) + ' km\n' +
      'Km: ' + fmt(q.kmCost) + '\nPeajes: ' + fmt(q.tolls) + '\nTOTAL: ' + fmt(q.total);
    return {
      id: String(Date.now()), title: 'Viaje ' + (client ? client + ' – ' : '') + s[0] + ' → ' + s[s.length - 1],
      startISO: new Date(when).toISOString(), durationSec: secs, stops: s, description: desc,
      total: q.total, km: q.km, client: client, kmCost: q.kmCost, tolls: q.tolls, roundTrip: $('roundTrip').checked
    };
  }

  function saveReservation() {
    var r = buildReservation(); if (!r) return;
    var list = LS.get('reservas', []); list.unshift(r); LS.set('reservas', list);
    renderList(); closeReservation();
    showTab('reservas');
    window.scrollTo(0, 0);
    if ($('addCal').checked) window.open(googleCalendarURL(r), '_blank'); // calendario
  }
  function downloadICS(r) {
    var blob = new Blob([buildICS(r)], { type: 'text/calendar' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'reserva-' + r.id + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- pestañas ----------
  var curTab = 'cotizar';
  var TABS = { cotizar: ['planner', 'tabTrip'], reservas: ['resView', 'tabRes'] };
  function showTab(name) {
    if (trip) return; // con un viaje en curso solo se ve el medidor
    curTab = name;
    Object.keys(TABS).forEach(function (k) {
      $(TABS[k][0]).style.display = k === name ? 'block' : 'none';
      $(TABS[k][1]).classList.toggle('on', k === name);
    });
    $('tabs').style.display = 'flex';
  }

  // ---------- reservas ----------
  var resOpen = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function renderList() {
    var all = LS.get('reservas', []);
    var pend = all.filter(function (r) { return !r.finished; })
      .sort(function (a, b) { return new Date(a.startISO) - new Date(b.startISO); });
    var done = all.filter(function (r) { return r.finished; });

    var box = $('list'); box.innerHTML = '';
    if (!pend.length) box.appendChild(el('p', 'muted', 'No tenés reservas pendientes. Creá una desde la pestaña Cotizar.'));
    pend.forEach(function (r) {
      var d = el('div', 'card res clickable');
      var h = el('div', 'rowline'); h.appendChild(el('b', '', r.title));
      var lab = dayLabel(r.startISO);
      if (lab) h.appendChild(el('span', 'chip' + (lab === 'Vencida' ? ' warn' : ''), lab));
      d.appendChild(h);
      d.appendChild(el('div', 'muted', new Date(r.startISO).toLocaleString('es-AR', { dateStyle: 'full', timeStyle: 'short' })));
      var f = el('div', 'rowline'); f.style.marginTop = '6px';
      f.appendChild(el('span', 'muted', r.km.toFixed(1) + ' km' + (r.client ? ' · ' + r.client : '')));
      f.appendChild(el('b', 'amt', fmt(r.total) + '  ›'));
      d.appendChild(f);
      d.onclick = function () { openReservation(r); };
      box.appendChild(d);
    });

    $('doneBox').style.display = done.length ? 'block' : 'none';
    var dbox = $('doneList'); dbox.innerHTML = '';
    done.forEach(function (r) {
      var d = el('div', 'card res');
      var h = el('div', 'rowline'); h.appendChild(el('b', '', r.title)); h.appendChild(el('b', 'amt', fmt(r.total)));
      d.appendChild(h);
      d.appendChild(el('div', 'muted', new Date(r.startISO).toLocaleString('es-AR') + ' · ' + r.km.toFixed(1) + ' km · espera ' + (r.waitMin || 0) + ' min · ✔ realizado'));
      dbox.appendChild(d);
    });
  }

  function openReservation(r) {
    resOpen = r;
    $('resListBox').style.display = 'none'; $('resDetail').style.display = 'block';
    $('rdTitle').textContent = r.title;
    $('rdWhen').textContent = new Date(r.startISO).toLocaleString('es-AR', { dateStyle: 'full', timeStyle: 'short' });
    $('rdClient').textContent = r.client || '—';
    $('rdRoute').textContent = r.stops.join(' → ') + (r.roundTrip ? '  (ida y vuelta)' : '');
    var kmCost = r.kmCost != null ? r.kmCost : r.total, tolls = r.tolls || 0;
    $('rdBreak').innerHTML = '';
    [[r.km.toFixed(1) + ' km', fmt(kmCost)], ['Peajes', fmt(tolls)]].forEach(function (x) {
      var row = el('div', 'row'); row.appendChild(el('span', '', x[0])); row.appendChild(el('b', '', x[1]));
      $('rdBreak').appendChild(row);
    });
    var tot = el('div', 'row total'); tot.appendChild(el('span', '', 'TOTAL RESERVADO')); tot.appendChild(el('b', '', fmt(r.total)));
    $('rdBreak').appendChild(tot);
    var wp = parseFloat($('waitPrice').value) || 0, gr = parseFloat($('grace').value) || 0;
    $('rdWaitInfo').textContent = 'Espera: ' + fmt(wp) + ' por minuto' + (gr ? ' (' + gr + ' min gratis)' : '') +
      '. Se mide durante el viaje.';
    $('rdMaps').href = mapsURL(r.stops);
    window.scrollTo(0, 0);
  }
  function closeReservation() {
    resOpen = null;
    $('resDetail').style.display = 'none'; $('resListBox').style.display = 'block';
  }

  root.showTab = showTab;

  // ---------- Viaje en curso (taxímetro de espera) ----------
  var trip = null, tickTimer = null, wakeLock = null;

  function requestWake() {
    try {
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
    } catch (e) {}
  }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }

  function beginTrip(base) {
    showError('');
    var wp = parseFloat($('waitPrice').value) || 0, gr = parseFloat($('grace').value) || 0;
    LS.set('waitPrice', wp); LS.set('grace', gr);
    trip = Object.assign({
      id: String(Date.now()), startedAt: Date.now(), extras: [], waitMs: 0, waitingSince: null, waitPrice: wp, grace: gr
    }, base);
    LS.set('trip', trip);
    showTrip();
  }
  // Viaje sin reserva previa (recién cotizado)
  function startTrip() {
    if (!state.lastQuote || !state.route) return showError('Primero calculá el viaje.');
    var q = state.lastQuote;
    beginTrip({
      stops: state.stops, client: $('client').value.trim(), km: q.km, kmCost: q.kmCost, tolls: q.tolls,
      durationSec: parseDurationSeconds(state.route.duration) * ($('roundTrip').checked ? 2 : 1),
      roundTrip: $('roundTrip').checked
    });
  }
  // Viaje desde una reserva guardada
  function startFromReservation() {
    var r = resOpen; if (!r) return;
    beginTrip({
      id: r.id, resId: r.id, scheduledISO: r.startISO, title: r.title, stops: r.stops, client: r.client || '',
      km: r.km, kmCost: r.kmCost != null ? r.kmCost : r.total, tolls: r.tolls || 0,
      durationSec: r.durationSec || 0, roundTrip: !!r.roundTrip
    });
  }

  function showTrip() {
    ['planner', 'resView', 'tabs', 'summary'].forEach(function (id) { $(id).style.display = 'none'; });
    $('tripCard').style.display = 'block';
    $('tripRoute').textContent = (trip.client ? trip.client + ' · ' : '') + trip.stops.join(' → ');
    requestWake();
    clearInterval(tickTimer);
    tickTimer = setInterval(renderTrip, 1000);
    renderTrip();
  }

  function renderTrip() {
    if (!trip) return;
    var now = Date.now(), t = tripTotals(trip, now), waiting = !!trip.waitingSince;
    $('tTotal').textContent = fmt(t.total);
    $('tElapsed').textContent = fmtDur(now - trip.startedAt);
    $('tWait').textContent = fmtDur(tripWaitMs(trip, now));
    $('tWaitCost').textContent = fmt(t.wait.cost) + (trip.grace ? ' (' + trip.grace + ' min de gracia)' : '');
    $('tBase').textContent = fmt(trip.kmCost + trip.tolls) + (t.extras ? ' + extras ' + fmt(t.extras) : '');
    $('waitBtn').textContent = waiting ? '⏸ Terminar espera' : '⏱ Iniciar espera';
    $('waitBtn').className = waiting ? 'danger' : '';
    $('tripCard').classList.toggle('waiting', waiting);
  }

  function toggleWait() {
    if (!trip) return;
    var now = Date.now();
    if (trip.waitingSince) { trip.waitMs += now - trip.waitingSince; trip.waitingSince = null; }
    else trip.waitingSince = now;
    LS.set('trip', trip);
    if (navigator.vibrate) navigator.vibrate(60);
    renderTrip();
  }

  function addExtra() {
    if (!trip) return;
    var v = prompt('Monto del extra (peaje, estacionamiento, etc.) en ARS:');
    var n = parseFloat(String(v || '').replace(',', '.'));
    if (!(n > 0)) return;
    trip.extras.push(n); LS.set('trip', trip); renderTrip();
  }

  function finishTrip() {
    if (!trip) return;
    if (!confirm('¿Finalizar el viaje?')) return;
    var now = Date.now();
    if (trip.waitingSince) { trip.waitMs += now - trip.waitingSince; trip.waitingSince = null; }
    var t = tripTotals(trip, now);
    var s = trip.stops, client = trip.client;
    var desc = 'Cliente: ' + (client || '-') + '\n' +
      (trip.scheduledISO ? 'Reservado para: ' + new Date(trip.scheduledISO).toLocaleString('es-AR') + '\n' : '') +
      'Recorrido: ' + s.join(' → ') + (trip.roundTrip ? ' (ida y vuelta)' : '') + '\n' +
      'Distancia: ' + trip.km.toFixed(1) + ' km → ' + fmt(trip.kmCost) + '\n' +
      'Peajes: ' + fmt(trip.tolls) + '\n' +
      (t.extras ? 'Extras: ' + fmt(t.extras) + '\n' : '') +
      'Espera: ' + fmtDur(tripWaitMs(trip, now)) + ' → ' + fmt(t.wait.cost) + '\n' +
      'TOTAL: ' + fmt(t.total);
    var r = {
      id: trip.id, title: trip.title || ('Viaje ' + (client ? client + ' – ' : '') + s[0] + ' → ' + s[s.length - 1]),
      startISO: new Date(trip.startedAt).toISOString(),
      durationSec: Math.round((now - trip.startedAt) / 1000), stops: s, description: desc,
      total: t.total, km: trip.km, client: client, finished: true, waitMin: Math.round(tripWaitMs(trip, now) / 60000),
      kmCost: trip.kmCost, tolls: trip.tolls, extras: t.extras, waitCost: t.wait.cost
    };
    // si venía de una reserva, esa reserva pasa a "realizada"
    var list = LS.get('reservas', []).filter(function (x) { return x.id !== r.id; }); list.unshift(r); LS.set('reservas', list);
    LS.set('trip', null); trip = null; clearInterval(tickTimer); releaseWake();
    $('tripCard').style.display = 'none';
    closeReservation(); showTab('reservas');
    $('summaryText').textContent = desc;
    $('waShare').href = 'https://wa.me/?text=' + encodeURIComponent(desc);
    $('summary').style.display = 'block';
    renderList();
    window.scrollTo(0, 0);
  }

  function cancelTrip() {
    if (!trip || !confirm('¿Cancelar el viaje sin guardarlo?')) return;
    var fromRes = !!trip.resId;
    LS.set('trip', null); trip = null; clearInterval(tickTimer); releaseWake();
    $('tripCard').style.display = 'none';
    closeReservation(); showTab(fromRes ? 'reservas' : 'cotizar');
  }

  document.addEventListener('visibilitychange', function () { if (trip && !document.hidden) { requestWake(); renderTrip(); } });

  document.addEventListener('DOMContentLoaded', function () {
    $('waitPrice').value = LS.get('waitPrice', 0);
    $('grace').value = LS.get('grace', 5);
    $('waitPrice').onchange = function () { LS.set('waitPrice', parseFloat($('waitPrice').value) || 0); };
    $('grace').onchange = function () { LS.set('grace', parseFloat($('grace').value) || 0); };
    $('startTrip').onclick = startTrip;
    $('rdStart').onclick = startFromReservation;
    $('rdBack').onclick = closeReservation;
    $('rdDel').onclick = function () {
      if (!resOpen || !confirm('¿Borrar esta reserva?')) return;
      var id = resOpen.id; LS.set('reservas', LS.get('reservas', []).filter(function (x) { return x.id !== id; }));
      closeReservation(); renderList();
    };
    $('rdIcs').onclick = function () { if (resOpen) downloadICS(resOpen); };
    $('rdGcal').onclick = function () { if (resOpen) window.open(googleCalendarURL(resOpen), '_blank'); };
    $('tabTrip').onclick = function () { showTab('cotizar'); };
    $('tabRes').onclick = function () { closeReservation(); showTab('reservas'); };
    $('waitBtn').onclick = toggleWait;
    $('extraBtn').onclick = addExtra;
    $('finishBtn').onclick = finishTrip;
    $('cancelBtn').onclick = cancelTrip;
    $('closeSummary').onclick = function () { $('summary').style.display = 'none'; };
    trip = LS.get('trip', null);
    if (trip) showTrip(); else showTab('cotizar');

    $('apiKey').value = LS.get('apiKey', '');
    $('pricePerKm').value = LS.get('pricePerKm', 1000);
    $('emission').value = LS.get('emission', 'GASOLINE');
    addStopInput(''); addStopInput('');
    $('addStop').onclick = function () {
      var last = $('stops').lastElementChild; // inserta antes del destino
      addStopInput(''); var rows = $('stops').children;
      $('stops').insertBefore(rows[rows.length - 1], last); relabel();
    };
    $('calc').onclick = calculate;
    $('roundTrip').onchange = renderQuote;
    $('manualToll').oninput = renderQuote;
    $('pricePerKm').oninput = renderQuote;
    $('save').onclick = saveReservation;
    renderList();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})(typeof window !== 'undefined' ? window : globalThis);
