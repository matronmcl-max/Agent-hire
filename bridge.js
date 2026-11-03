// Bridge front end: polls the server for the hand state and sends the
// human's bids and card plays. No game logic lives here — the engine on
// the server decides what is legal and what happens next.
(function () {
  var session = null;
  var lastState = null;
  // Running score across hands, kept in this browser so it survives
  // a new hand (and a page reload). Counted once per hand, on finish.
  var total = { hands: 0, yourWins: 0, score: 0 };
  try { var saved = JSON.parse(localStorage.getItem('bridgeTotal') || 'null'); if (saved) total = saved; } catch (e) {}
  var countedSession = null;
  var seatNames = { N: 'North', E: 'East', S: 'South (you)', W: 'West' };
  var manualPaused = false, autoPaused = false;
  // $ must be defined before any listener uses it — it used to be
  // defined below the pause-button listener, so calling it there
  // threw and the whole script died before ever dealing a hand.
  // That is why the page stuck on "Dealing a hand…" forever.
  var $ = function (id) { return document.getElementById(id); };
  function sendPause(paused) {
    if (!session) return;
    fetch('/v1/bridge/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, paused: paused }) })
      .then(function (res) { return res.json(); })
      .then(function (state) { render(state); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (!manualPaused && !autoPaused) { autoPaused = true; sendPause(true); }
    } else if (autoPaused && !manualPaused) {
      autoPaused = false; sendPause(false);
    }
  });
  $('pause-btn').addEventListener('click', function () {
    manualPaused = !manualPaused;
    autoPaused = false;
    sendPause(manualPaused);
  });
  var statusEl = $('status'), errorEl = $('error'), metaEl = $('meta');

  function show(el, on) { el.style.display = on ? '' : 'none'; }
  function suitClass(card) { return (card.suit === 'H' || card.suit === 'D') ? 'card-btn red-suit' : 'card-btn'; }

  function cardButton(card, enabled, onClick) {
    var b = document.createElement('button');
    b.className = suitClass(card);
    b.textContent = card.text;
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  function renderAuction(state) {
    var body = $('auction-body');
    body.innerHTML = '';
    // Bids arrive in seat order; lay them out in rounds of four starting
    // at the first bidder's column.
    var order = ['N', 'E', 'S', 'W'];
    var bids = state.bids || [];
    var start = bids.length ? order.indexOf(bids[0].by) : 0;
    var row = null, col = start;
    bids.forEach(function (bid) {
      if (!row || col === 0 && row) { row = document.createElement('tr'); body.appendChild(row); }
      // Fill any skipped columns (should not happen, but keeps the grid true).
      while (row.children.length < col) { row.appendChild(document.createElement('td')); }
      var td = document.createElement('td');
      td.textContent = bid.text;
      if (bid.by === 'S') td.style.fontWeight = '700';
      row.appendChild(td);
      col = (col + 1) % 4;
      if (col === 0) row = null;
    });
    show($('auction-box'), bids.length > 0);
  }

  function render(state) {
    lastState = state;
    errorEl.textContent = state.error || '';
    // A dead session (e.g. the site was redeployed and in-memory hands
    // were lost) must not leave stale bid buttons on screen. Hide the
    // game boxes and offer a fresh hand instead of freezing.
    if (state.error) {
      statusEl.textContent = 'That hand is gone — deal a new one.';
      metaEl.textContent = '';
      show($('auction-box'), false);
      show($('bid-box'), false);
      show($('contract-box'), false);
      show($('trick-box'), false);
      show($('score-box'), false);
      show($('history-box'), false);
      show($('dummy-box'), false);
      show($('play-box'), false);
      show($('result-box'), true);
      $('result-text').textContent = 'The site was updated while you were playing, so that hand was lost. Tap below for a fresh hand.';
      return;
    }
    metaEl.textContent = 'Dealer: ' + (state.dealerName || '—') + '  •  Vulnerable: ' +
      (state.vulnerability === 'none' ? 'Nobody' : state.vulnerability === 'both' ? 'Both teams' : (state.vulnerability || '—')) +
      '  •  Your team: North + South';
    renderAuction(state);

    $('pause-btn').textContent = state.paused ? 'Resume the robots' : 'Pause the robots';
    if (state.paused && state.status !== 'complete') {
      statusEl.textContent = 'Paused — the robots are waiting for you. Nothing will move until you come back.';
    } else if (state.status === 'bidding') {
      statusEl.textContent = state.pending
        ? 'Your turn to bid.'
        : 'The robots are bidding…';
    } else if (state.status === 'play') {
      if (state.pending) {
        statusEl.textContent = state.pending.playingDummy
          ? 'Your turn — play one of North’s cards (you are the declarer).'
          : 'Your turn to play a card.';
      } else {
        statusEl.textContent = (state.contract && state.contract.dummySeat === 'S')
          ? 'You are dummy this hand — the robots play your cards. Watch the table.'
          : 'The robots are playing…';
      }
    } else if (state.status === 'complete') {
      statusEl.textContent = state.passedOut ? 'Everyone passed — no hand played.' : 'Hand finished.';
    }

    // Bidding buttons.
    var pendingBid = state.pending && state.pending.kind === 'bid';
    show($('bid-box'), !!pendingBid);
    if (pendingBid) {
      var grid = $('bid-grid');
      grid.innerHTML = '';
      var legal = {};
      state.pending.legalBids.forEach(function (b) { legal[b.id] = b; });
      var all = [{ id: 'pass', text: 'Pass' }];
      for (var level = 1; level <= 7; level++) {
        ['c', 'd', 'h', 's', 'n'].forEach(function (s) {
          all.push({ id: level + s, text: level + ({ c: '♣', d: '♦', h: '♥', s: '♠', n: 'NT' })[s] });
        });
      }
      all.push({ id: 'dbl', text: 'Double' }, { id: 'rdbl', text: 'Redouble' });
      all.forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'bid-btn';
        btn.textContent = b.text;
        btn.disabled = !legal[b.id];
        if (legal[b.id]) btn.addEventListener('click', function () { sendBid(b.id); });
        grid.appendChild(btn);
      });
    }

    // Scoreboard: tricks this hand, plus the running total across hands.
    var isNS = state.contract && (state.contract.declarer === 'N' || state.contract.declarer === 'S');
    var yourTricks = state.contract ? (isNS ? state.declarerTricks : state.defenseTricks) : 0;
    var theirTricks = state.contract ? (isNS ? state.defenseTricks : state.declarerTricks) : 0;
    if (state.status === 'complete' && state.result && !state.passedOut && countedSession !== state.session) {
      countedSession = state.session;
      total.hands += 1;
      if (state.result.yourTeamScore > 0) total.yourWins += 1;
      total.score += state.result.yourTeamScore;
      try { localStorage.setItem('bridgeTotal', JSON.stringify(total)); } catch (e) {}
    }
    show($('score-box'), !!state.contract);
    if (state.contract) {
      $('score-text').textContent = 'This hand — your team: ' + yourTricks + ' tricks • other team: ' + theirTricks + ' tricks';
      $('total-score-text').textContent = 'Running total — ' + total.hands + ' hand' + (total.hands === 1 ? '' : 's') +
        ', your team won ' + total.yourWins + ', total score ' + (total.score >= 0 ? '+' : '') + total.score +
        (total.hands === 0 ? ' (finish a hand and it starts counting)' : '');
    }

    // Trick history: every finished trick, so a won trick does not vanish
    // the moment the next trick starts.
    var hist = state.completedTricks || [];
    show($('history-box'), hist.length > 0);
    if (hist.length > 0) {
      var hl = $('history-list');
      hl.innerHTML = '';
      hist.forEach(function (t, i) {
        var bySeat = {};
        t.plays.forEach(function (p) { bySeat[p.by] = p.text; });
        var wonByYou = t.winner === 'N' || t.winner === 'S';
        var line = document.createElement('p');
        line.textContent = 'Trick ' + (i + 1) + ': North ' + (bySeat.N || '—') + ' • East ' + (bySeat.E || '—') +
          ' • South ' + (bySeat.S || '—') + ' • West ' + (bySeat.W || '—') +
          ' → won by ' + (seatNames[t.winner] || t.winner) + (wonByYou ? ' — your team pulled this one.' : '');
        if (wonByYou) line.style.fontWeight = '700';
        hl.appendChild(line);
      });
    }

    // Contract + trick score.
    show($('contract-box'), !!state.contract);
    if (state.contract) {
      var c = state.contract;
      $('contract-text').textContent = c.text + ' by ' + c.declarerName +
        (c.vulnerable ? ' (vulnerable)' : ' (not vulnerable)') +
        ' — needs ' + c.tricksNeeded + ' tricks.';
      $('trick-score').textContent = 'Tricks won: your team ' +
        (c.declarer && (c.declarer === 'N' || c.declarer === 'S') ? state.declarerTricks : state.defenseTricks) +
        ' • other team ' +
        (c.declarer && (c.declarer === 'N' || c.declarer === 'S') ? state.defenseTricks : state.declarerTricks);
    }

    // Current trick — shown as a real table, North top, West left,
    // East right, South bottom, so you can see who played what.
    var trick = state.currentTrick || [];
    show($('trick-box'), trick.length > 0);
    ['N', 'W', 'E', 'S'].forEach(function (seat) {
      var slot = $('trick-' + seat);
      if (!slot) return;
      var played = slot.querySelector('.played');
      var p = null;
      trick.forEach(function (t) { if (t.by === seat) p = t; });
      if (played) {
        played.textContent = p ? p.text : '—';
        played.className = 'played' + ((p && (p.text.indexOf('♥') >= 0 || p.text.indexOf('♦') >= 0)) ? ' red-suit' : '');
      }
    });

    // Dummy hand: face up after the opening lead. If you are the
    // declarer, you tap these cards; otherwise you just watch them.
    var showDummy = !!state.dummyHand;
    show($('dummy-box'), showDummy);
    if (showDummy) {
      var dummyIsYou = state.contract.dummySeat === 'S';
      $('dummy-title').textContent = state.contract.dummyName + "'s cards (face up)";
      $('dummy-note').textContent = dummyIsYou
        ? 'These are your cards, played by the declarer (North).'
        : (state.pending && state.pending.playingDummy
          ? 'You are the declarer, so you play these cards too.'
          : 'Everyone can see these cards.');
      var dh = $('dummy-hand');
      dh.innerHTML = '';
      var dummyPlayable = !!(state.pending && state.pending.playingDummy);
      var eligible = {};
      if (state.pending) state.pending.eligibleCards.forEach(function (card) { eligible[card.id] = true; });
      state.dummyHand.forEach(function (card) {
        dh.appendChild(cardButton(card, dummyPlayable && eligible[card.id], function () { sendPlay(card.id); }));
      });
    }

    // Your own hand, always visible. Tappable only on your turn, and
    // only the cards the rules allow right now.
    show($('play-box'), true);
    $('play-title').textContent = 'Your cards (South)';
    var playable = !!(state.pending && state.pending.kind === 'play');
    $('play-note').textContent = playable
      ? 'Tap a card you are allowed to play. You must follow the suit that was led if you can.'
      : (state.status === 'complete' ? 'Hand over.' : 'Wait for your turn — your cards stay here.');
    var ph = $('play-hand');
    ph.innerHTML = '';
    var eligiblePlay = {};
    if (state.pending && state.pending.eligibleCards) state.pending.eligibleCards.forEach(function (card) { eligiblePlay[card.id] = true; });
    state.southHand.forEach(function (card) {
      ph.appendChild(cardButton(card, playable && eligiblePlay[card.id], function () { sendPlay(card.id); }));
    });

    // Result.
    var done = state.status === 'complete';
    show($('result-box'), done);
    if (done) {
      if (state.passedOut) {
        $('result-text').textContent = 'Nobody bid, so this hand was passed out. Deal another one.';
      } else if (state.result) {
        var r = state.result;
        var madeWord = r.made ? 'made' : 'went down';
        $('result-text').innerHTML = 'Contract ' + state.contract.text + ' by ' + state.contract.declarerName +
          ' ' + madeWord + ': ' + r.declarerTricks + ' tricks won, ' + r.tricksNeeded + ' needed.' +
          '<br>Your team pulled ' + (isNS ? r.declarerTricks : state.defenseTricks) + ' tricks this hand.' +
          '<br>Your team’s score for this hand: <strong>' + (r.yourTeamScore >= 0 ? '+' : '') + r.yourTeamScore + '</strong>.' +
          '<br>Running total: <strong>' + (total.score >= 0 ? '+' : '') + total.score + '</strong> after ' + total.hands + ' hand' + (total.hands === 1 ? '' : 's') + '.' +
          (r.yourTeamScore < 0 ? '<br><span class="red">The other team won this hand.</span>' : '');
      }
    }
  }

  function poll() {
    if (!session) return;
    fetch('/v1/bridge/state?session=' + encodeURIComponent(session))
      .then(function (res) { return res.json(); })
      .then(function (state) { render(state); if (state.status !== 'complete' && !state.error) setTimeout(poll, 700); })
      .catch(function () { setTimeout(poll, 1500); });
  }

  function sendBid(bid) {
    fetch('/v1/bridge/bid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, bid: bid }) })
      .then(function (res) { return res.json(); })
      .then(function (state) { render(state); poll(); })
      .catch(function () { poll(); });
  }
  function sendPlay(card) {
    fetch('/v1/bridge/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, card: card }) })
      .then(function (res) { return res.json(); })
      .then(function (state) { render(state); poll(); })
      .catch(function () { poll(); });
  }

  function newHand() {
    statusEl.textContent = 'Dealing a hand…';
    show($('result-box'), false);
    fetch('/v1/bridge/new', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) { session = data.session; try { localStorage.setItem('bridgeSession', session); } catch (e) {} poll(); });
  }

  // No move timer: a turn never expires on the server. And reloading
  // the page must not throw a hand away — resume the hand you were
  // on, and only deal a fresh one if that hand is really gone.
  function resumeOrNew() {
    var savedSession = null;
    try { savedSession = localStorage.getItem('bridgeSession'); } catch (e) {}
    if (!savedSession) { newHand(); return; }
    statusEl.textContent = 'Picking up your hand…';
    fetch('/v1/bridge/state?session=' + encodeURIComponent(savedSession))
      .then(function (res) { return res.json(); })
      .then(function (state) {
        if (state.error) { newHand(); return; }
        session = savedSession;
        render(state);
        if (state.status !== 'complete') poll();
      })
      .catch(function () { newHand(); });
  }

  $('new-hand').addEventListener('click', newHand);
  resumeOrNew();
})();
