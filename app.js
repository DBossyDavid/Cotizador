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
    mapsURL: mapsURL, buildRoutesRequest: buildRoutesRequest
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
      total: q.total, km: q.km, client: client
    };
  }

  function saveReservation() {
    var r = buildReservation(); if (!r) return;
    var list = LS.get('reservas', []); list.unshift(r); LS.set('reservas', list);
    renderList();
    // Calendario: abre Google Calendar con el evento cargado
    window.open(googleCalendarURL(r), '_blank');
  }
  function downloadICS(r) {
    var blob = new Blob([buildICS(r)], { type: 'text/calendar' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'reserva-' + r.id + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function renderList() {
    var list = LS.get('reservas', []), box = $('list');
    box.innerHTML = list.length ? '' : '<p class="muted">Todavía no hay reservas guardadas.</p>';
    list.forEach(function (r) {
      var d = document.createElement('div'); d.className = 'card res';
      d.innerHTML = '<b></b><div class="muted"></div><div class="muted"></div>';
      d.children[0].textContent = r.title;
      d.children[1].textContent = new Date(r.startISO).toLocaleString('es-AR') + ' · ' + r.km.toFixed(1) + ' km';
      d.children[2].textContent = 'Total ' + fmt(r.total);
      var b1 = document.createElement('button'); b1.textContent = 'Agregar al calendario (.ics)'; b1.className = 'small';
      b1.onclick = function () { downloadICS(r); };
      var b2 = document.createElement('button'); b2.textContent = 'Borrar'; b2.className = 'small danger';
      b2.onclick = function () { LS.set('reservas', LS.get('reservas', []).filter(function (x) { return x.id !== r.id; })); renderList(); };
      d.appendChild(b1); d.appendChild(b2); box.appendChild(d);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
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
    $('icsNow').onclick = function () { var r = buildReservation(); if (r) downloadICS(r); };
    renderList();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})(typeof window !== 'undefined' ? window : globalThis);
