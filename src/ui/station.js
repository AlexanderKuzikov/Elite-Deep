/**
 * Station screens: market, equipment, status and the system chart.
 *
 * These are DOM rather than canvas, unlike the HUD. The distinction is not
 * arbitrary: the HUD is a *display* that must repaint sixty times a second and
 * shows continuous values, while these are *menus* - discrete rows, hover
 * states, clicks and keyboard navigation. Reimplementing hit-testing and focus
 * management on a canvas would be a large amount of code to arrive back at what
 * the browser already does.
 *
 * The screens build their DOM once and then patch it on update, rather than
 * rebuilding on every state change. That is the difference between a market
 * screen that scrolls smoothly and one that flickers.
 */

import * as PLAYER from '../logic/player.js';
import * as REP from '../logic/reputation.js';
import * as F from '../logic/factions.js';

/** Shared styling, injected once. Kept as a string so there is no CSS file. */
export const STATION_CSS = `
.elite-screen {
  position: absolute; inset: 0; display: none;
  background: rgba(4, 8, 14, 0.94);
  font-family: "SF Mono", "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace;
  font-size: 13px; color: #9fe8ff;
  z-index: 10; overflow: hidden;
}
.elite-screen.open { display: flex; flex-direction: column; }
.elite-title {
  padding: 18px 24px 12px; font-size: 20px; letter-spacing: 0.14em;
  color: #e8f6ff; text-transform: uppercase; border-bottom: 1px solid rgba(159,232,255,0.22);
}
.elite-sub { padding: 6px 24px 0; color: rgba(159,232,255,0.55); font-size: 12px; }
.elite-tabs { display: flex; gap: 2px; padding: 12px 24px 0; }
.elite-tab {
  padding: 7px 18px; cursor: pointer; color: rgba(159,232,255,0.55);
  border: 1px solid transparent; border-bottom: none; text-transform: uppercase;
  letter-spacing: 0.08em; font-size: 12px;
}
.elite-tab:hover { color: #9fe8ff; }
.elite-tab.active {
  color: #e8f6ff; background: rgba(159,232,255,0.08);
  border-color: rgba(159,232,255,0.22);
}
.elite-body { flex: 1; overflow-y: auto; padding: 14px 24px 20px; }
.elite-table { width: 100%; border-collapse: collapse; }
.elite-table th {
  text-align: left; padding: 8px 10px; font-weight: normal; font-size: 11px;
  letter-spacing: 0.1em; color: rgba(159,232,255,0.45);
  border-bottom: 1px solid rgba(159,232,255,0.18); text-transform: uppercase;
}
.elite-table td { padding: 7px 10px; border-bottom: 1px solid rgba(159,232,255,0.06); }
.elite-table tr.selectable { cursor: pointer; }
.elite-table tr.selectable:hover td { background: rgba(159,232,255,0.09); }
.elite-table tr.selected td { background: rgba(159,232,255,0.15); color: #e8f6ff; }
.elite-table tr.no-stock td { color: rgba(159,232,255,0.28); }
.elite-num { text-align: right; font-variant-numeric: tabular-nums; }
.elite-good { color: #8affb0; }
.elite-warn { color: #ffd27a; }
.elite-bad { color: #ff6a5a; }
.elite-dim { color: rgba(159,232,255,0.45); }
.elite-key { color: #e8f6ff; background: rgba(159,232,255,0.10); padding: 1px 5px; border-radius: 2px; }
.elite-hint {
  padding: 10px 24px; border-top: 1px solid rgba(159,232,255,0.18);
  color: rgba(159,232,255,0.55); font-size: 12px;
}
.elite-panel {
  border: 1px solid rgba(159,232,255,0.18); padding: 14px 16px; margin-bottom: 14px;
  background: rgba(159,232,255,0.03);
}
.elite-row { display: flex; justify-content: space-between; padding: 4px 0; }
.elite-row-label { color: rgba(159,232,255,0.55); }
.elite-bar { height: 6px; background: rgba(159,232,255,0.12); margin-top: 5px; }
.elite-bar > div { height: 100%; background: #9fe8ff; }
.elite-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.elite-msg {
  position: absolute; left: 50%; top: 14%; transform: translateX(-50%);
  background: rgba(6,10,16,0.92); border: 1px solid rgba(159,232,255,0.3);
  padding: 10px 22px; color: #ffd27a; pointer-events: none;
  opacity: 0; transition: opacity 0.18s; z-index: 20;
}
.elite-msg.show { opacity: 1; }
`;

/**
 * Build the station UI. Returns an object with `open`, `close`, `update`, and
 * the DOM node, so the caller only has to feed it state and listen for actions.
 *
 * `on` is the action callback: { buy, sell, equip, repair, refuel, undock,
 * launch, save, load, discard }. Every action receives a plain descriptor and
 * the current market, so the caller owns all mutation.
 */
export function createStationUI(host, on) {
  const actions = on || {};
  let selectedMarket = 0;
  let selectedEquip = 0;
  // Offers and live contracts share one selection index: offers first, then
  // the taken ones. One cursor over one list is easier to drive with a hat
  // switch than two cursors over two lists.
  let selectedContract = 0;
  let tab = 'market';
  let currentMarket = [];
  let currentState = null;

  injectCss(host);

  const root = el('div', 'elite-screen');
  root.appendChild(el('div', 'elite-title', 'Station Services'));
  const sub = el('div', 'elite-sub');
  root.appendChild(sub);

  const tabs = el('div', 'elite-tabs');
  const TAB_NAMES = [['market', 'Market'], ['equip', 'Equipment'],
    ['contracts', 'Contracts'], ['status', 'Status']];
  const tabEls = {};
  for (const [id, label] of TAB_NAMES) {
    const t = el('div', 'elite-tab', label);
    t.addEventListener('click', () => setTab(id));
    tabs.appendChild(t);
    tabEls[id] = t;
  }
  root.appendChild(tabs);

  const body = el('div', 'elite-body');
  root.appendChild(body);

  const hint = el('div', 'elite-hint');
  root.appendChild(hint);

  const toast = el('div', 'elite-msg');
  root.appendChild(toast);

  const message = el('div', 'elite-sub');
  host.appendChild(root);

  // --- Tabs -------------------------------------------------------------

  function setTab(id) {
    tab = id;
    for (const [k, e] of Object.entries(tabEls)) e.classList.toggle('active', k === id);
    render();
  }

  // --- Rendering --------------------------------------------------------

  function render() {
    if (!currentState) return;
    const s = currentState;
    sub.textContent = s.system.name + '  -  ' + F.faction(s.system.faction).name
      + '  -  ' + F.government(s.system.gov).name
      + '  -  ' + F.economy(s.system.econ).name
      // `condition` is a string id ('STABLE', 'FAMINE'), never a number, so
      // this is a plain "always show it" - the old `!== 0` guard was always
      // true and only looked like a check.
      + '  -  ' + F.condition(s.system.condition).name;
    body.textContent = '';
    if (tab === 'market') renderMarket(s);
    else if (tab === 'equip') renderEquip(s);
    else if (tab === 'contracts') renderContracts(s);
    else renderStatus(s);
    keepSelectionVisible();
    renderHint(s);
  }

  /**
   * Keep the selected row inside the scrolling body.
   *
   * The market has more rows than fit on a 720p screen - measured, 19 rows of
   * 724 px of content in a 569 px body, with the last row 45 px below the fold -
   * and the selection is moved with the arrow keys. `scrollTop` never moved off
   * zero, so the last rows could be selected and never seen: a way to buy the
   * wrong thing and not find out.
   *
   * Done by hand rather than with `scrollIntoView`, which also scrolls every
   * scrollable ancestor and would move the page under a fixed overlay.
   */
  function keepSelectionVisible() {
    const sel = body.querySelector('.selected');
    if (!sel || typeof body.getBoundingClientRect !== 'function'
      || typeof sel.getBoundingClientRect !== 'function') return;
    const view = body.getBoundingClientRect();
    const row = sel.getBoundingClientRect();
    // The row's position in the body's own *content* coordinates, which is the
    // space `scrollTop` lives in.
    const rowTop = row.top - view.top + body.scrollTop;
    body.scrollTop = revealScrollTop(body.scrollTop, body.clientHeight, rowTop, row.height);
  }

  function renderHint(s) {
    hint.textContent = '';
    hint.appendChild(span('Arrows', 'elite-key'));
    hint.appendChild(span(' select   '));
    hint.appendChild(span('Enter', 'elite-key'));
    if (tab === 'equip') hint.appendChild(span(' buy   '));
    else if (tab === 'contracts') hint.appendChild(span(' accept / abandon   '));
    else hint.appendChild(span(' all   '));
    if (tab === 'market') {
      hint.appendChild(span('1', 'elite-key'));
      hint.appendChild(span(' one tonne   '));
    }
    hint.appendChild(span('Tab', 'elite-key'));
    hint.appendChild(span(' switch screen   '));
    // `C`, not `D`. `dock` is bound to KeyC; KeyD is roll-right, which on this
    // screen moves the selection down - so the old hint told the commander to
    // press a key that scrolls the list they were trying to leave.
    hint.appendChild(span('C', 'elite-key'));
    hint.appendChild(span(' undock   '));
    hint.appendChild(span('Esc', 'elite-key'));
    hint.appendChild(span(' undock'));
  }

  /**
   * The market table.
   *
   * Every row carries both prices and both quantities, because the entire
   * decision in Elite is a comparison: is this cheaper here than where I am
   * going? Showing only the local price would make the screen useless.
   */
  function renderMarket(s) {
    const table = el('table', 'elite-table');
    const head = el('tr');
    for (const [label, cls] of [
      ['Commodity', ''], ['Stock', 'elite-num'], ['Buy', 'elite-num'],
      ['Sell', 'elite-num'], ['Hold', 'elite-num'],
    ]) {
      const th = el('th', cls, label);
      head.appendChild(th);
    }
    table.appendChild(head);

    currentMarket.forEach((row, i) => {
      const tr = el('tr', 'selectable');
      tr.classList.toggle('selected', i === selectedMarket);
      tr.classList.toggle('no-stock', !row.available);
      tr.addEventListener('click', () => { selectedMarket = i; render(); });
      tr.addEventListener('dblclick', () => doBuy(row));

      const nameTd = el('td', '', row.name);
      if (row.illegal) {
        nameTd.appendChild(span(' [BANNED]', 'elite-bad'));
      }
      tr.appendChild(nameTd);

      tr.appendChild(el('td', 'elite-num', row.available ? String(row.stock) : '-'));
      tr.appendChild(el('td', 'elite-num', row.available ? row.buyPrice.toFixed(1) : '-'));

      const sellTd = el('td', 'elite-num');
      if (row.held > 0) {
        sellTd.textContent = row.sellPrice.toFixed(1);
        // Highlight a sale that beats what we paid, if we know the cost.
        if (row.avgPaid && row.sellPrice > row.avgPaid) sellTd.className = 'elite-num elite-good';
        else if (row.avgPaid && row.sellPrice < row.avgPaid) sellTd.className = 'elite-num elite-bad';
      } else {
        sellTd.textContent = row.sellPrice.toFixed(1);
        sellTd.className = 'elite-num elite-dim';
      }
      tr.appendChild(sellTd);

      tr.appendChild(el('td', 'elite-num', String(row.held)));
      table.appendChild(tr);
    });

    body.appendChild(table);

    // A summary panel, because the one number that matters is free space.
    const free = currentState.hold - currentState.cargoUsed;
    const panel = el('div', 'elite-panel');
    panel.appendChild(row('Cash', currentState.cash.toFixed(1) + ' CR'));
    panel.appendChild(row('Cargo space', currentState.cargoUsed + ' / ' + currentState.hold
      + (free <= 0 ? '   (FULL)' : '')));
    const legal = currentState.legal;
    if (legal && legal.wanted) {
      panel.appendChild(row('Legal status', legal.label, 'elite-bad'));
    }
    body.appendChild(panel);
  }

  /**
   * Buy the maximum the hold allows, or as much as there is stock.
   *
   * `tonnes` overrides that, which is what the single-tonne key uses. The
   * maximum is the right default - it is what a trader wants nine times out of
   * ten - but it was the *only* option, and that made two ordinary situations
   * impossible: reserving cash for fuel or repairs while still taking a part
   * load, and buying into the last few tonnes of space without overshooting.
   */
  function doBuy(row, tonnes) {
    if (!row || !row.available) return notify('No stock available');
    if (!actions.buy) return;
    const free = currentState.hold - currentState.cargoUsed;
    if (free <= 0) return notify('Cargo hold is full');
    const afford = Math.floor(currentState.cash / row.buyPrice);
    const n = tonnes === undefined
      ? Math.min(free, row.stock, afford)
      : Math.min(tonnes, free, row.stock, afford);
    if (n <= 0) {
      return notify(afford <= 0 ? 'Not enough credits' : 'Nothing to buy');
    }
    actions.buy(row.id, n);
  }

  /**
   * Sell a quantity of a held commodity.
   *
   * The old behaviour sold the entire holding, which is a trap rather than a
   * convenience: a commander with a full hold and an empty tank could not sell
   * two tonnes to pay for fuel and keep the rest for a better market. There
   * was no way to raise a specific amount of cash.
   */
  function doSell(row, tonnes) {
    if (!row || !row.held) return;
    if (!actions.sell) return;
    const n = tonnes === undefined ? row.held : Math.min(tonnes, row.held);
    if (n <= 0) return notify('Nothing to sell');
    actions.sell(row.id, n);
  }

  /**
   * The contract board.
   *
   * Two lists in one table: what is on offer, then what is already taken. The
   * offers come first because that is the decision being made; the live ones
   * sit underneath as a reminder of what is already owed.
   */
  /**
   * The offers a commander can still take.
   *
   * Taken offers are dropped rather than shown greyed out. The job is already
   * in the list below as a live contract, and listing it twice - once dimmed at
   * the top as "accepted", again at the bottom as "in progress" - reads as a
   * duplicate, not as information. The commander sees it where it matters:
   * among the jobs they are carrying.
   *
   * The cursor design is unchanged: still one list, still one cursor, with the
   * available offers first and the taken ones after - just one row per job.
   * `MISSIONS.accept` remains the real guard against taking a job twice; the
   * screen no longer needs a second one.
   */
  function availableOffers(state) {
    return ((state && state.offers) || []).filter((o) => !o.taken);
  }

  function renderContracts(s) {
    const offers = availableOffers(s);
    const live = s.contracts || [];

    if (!offers.length && !live.length) {
      body.appendChild(el('div', 'elite-dim',
        'No contracts here today. Try a busier or more troubled system.'));
      return;
    }

    const table = el('table', 'elite-table');
    const head = el('tr');
    for (const [label, cls] of [['Contract', ''], ['To', ''], ['Days', 'elite-num'],
      ['Reward', 'elite-num'], ['', '']]) {
      head.appendChild(el('th', cls, label));
    }
    table.appendChild(head);

    offers.forEach((offer, i) => {
      const tr = el('tr', 'selectable');
      tr.classList.toggle('selected', i === selectedContract);
      tr.addEventListener('click', () => { selectedContract = i; render(); });
      tr.addEventListener('dblclick', () => { selectedContract = i; activateContract(); });

      const nameTd = el('td', '', offer.description);
      nameTd.appendChild(el('div', 'elite-dim', typeLabel(offer.type)));
      nameTd.lastChild.style.fontSize = '11px';
      tr.appendChild(nameTd);
      tr.appendChild(el('td', '', offer.targetName));
      tr.appendChild(el('td', 'elite-num', String(offer.days)));
      tr.appendChild(el('td', 'elite-num', offer.reward + ' CR'));
      // The last column says what Enter will do on this row, which is why the
      // live rows below say "abandon" and these say "accept".
      tr.appendChild(el('td', 'elite-dim', 'accept'));
      table.appendChild(tr);
    });

    live.forEach((c, i) => {
      const index = offers.length + i;
      const overdue = c.daysLeft < 0;
      const tr = el('tr', 'selectable');
      tr.classList.toggle('selected', index === selectedContract);
      tr.addEventListener('click', () => { selectedContract = index; render(); });
      tr.addEventListener('dblclick', () => { selectedContract = index; activateContract(); });

      const nameTd = el('td', '', c.description);
      nameTd.appendChild(el('div', 'elite-dim', 'in progress'));
      nameTd.lastChild.style.fontSize = '11px';
      tr.appendChild(nameTd);
      tr.appendChild(el('td', '', c.targetName));
      tr.appendChild(el('td', 'elite-num ' + (c.daysLeft <= 1 ? 'elite-bad' : ''), String(c.daysLeft)));
      tr.appendChild(el('td', 'elite-num', c.reward + ' CR'));
      tr.appendChild(el('td', overdue ? 'elite-bad' : 'elite-warn', 'abandon'));
      table.appendChild(tr);
    });

    body.appendChild(table);

    const panel = el('div', 'elite-panel');
    panel.appendChild(row('Contracts held', live.length + ' / ' + (s.maxContracts || 0)));
    panel.appendChild(row('Cargo space',
      s.cargoUsed + ' / ' + s.hold + (s.cargoUsed >= s.hold ? '   (FULL)' : '')));
    body.appendChild(panel);
    body.appendChild(el('div', 'elite-dim',
      'A delivery needs the goods in your hold when you dock at the destination.'));

    // Keep the cursor inside the list after a contract is taken or dropped.
    const total = offers.length + live.length;
    if (selectedContract >= total) selectedContract = Math.max(0, total - 1);
  }

  /** A human word for a contract type, for the second line of the row. */
  function typeLabel(type) {
    if (type === 'relief') return 'emergency relief';
    if (type === 'courier') return 'courier run';
    if (type === 'bounty') return 'bounty';
    return 'delivery';
  }

  /** Equipment: the upgrade list. One of each, and it stays bought. */
  function renderEquip(s) {
    const table = el('table', 'elite-table');
    const head = el('tr');
    for (const [label, cls] of [['Item', ''], ['Price', 'elite-num'], ['', '']]) {
      head.appendChild(el('th', cls, label));
    }
    table.appendChild(head);

    const items = PLAYER.EQUIPMENT;
    items.forEach((item, i) => {
      const owned = PLAYER.hasEquipment(s.player, item.id);
      const affordable = s.cash >= item.price;
      const tr = el('tr', 'selectable');
      tr.classList.toggle('selected', i === selectedEquip);
      tr.classList.toggle('no-stock', owned || !affordable);
      tr.addEventListener('click', () => { selectedEquip = i; render(); });
      tr.addEventListener('dblclick', () => doEquip(item));

      const nameTd = el('td', '', item.name);
      // The description is the reason to buy; without it the list is a price
      // tag with no meaning.
      if (item.desc) {
        nameTd.appendChild(el('div', 'elite-dim', item.desc));
        nameTd.lastChild.style.fontSize = '11px';
      }
      tr.appendChild(nameTd);

      tr.appendChild(el('td', 'elite-num', owned ? 'owned' : item.price + ' CR'));

      const status = owned ? 'installed' : affordable ? 'available' : 'too expensive';
      const statusCls = owned ? 'elite-good' : affordable ? 'elite-dim' : 'elite-bad';
      tr.appendChild(el('td', statusCls, status));
      table.appendChild(tr);
    });
    body.appendChild(table);

    // Repair and refuel live here rather than in a separate shop, because they
    // are the same kind of decision: spend credits to restore capability.
    const panel = el('div', 'elite-panel');
    const hullMissing = Math.max(0, s.maxHull - s.hull);
    const fuelMissing = Math.max(0, s.maxFuel - s.fuel);
    const repairPrice = PLAYER.repairCost(s.player);
    const refuelPrice = PLAYER.refuelCost(s.player);

    panel.appendChild(row('Hull', s.hull.toFixed(0) + ' / ' + s.maxHull.toFixed(0)));
    panel.appendChild(actionRow(
      'Repair' + (hullMissing > 0 ? ' (' + hullMissing.toFixed(0) + '%)' : ''),
      hullMissing > 0 ? repairPrice.toFixed(1) + ' CR' : 'no damage',
      hullMissing > 0 && s.cash >= repairPrice,
      () => actions.repair && actions.repair(),
    ));
    panel.appendChild(row('Fuel', s.fuel.toFixed(1) + ' / ' + s.maxFuel.toFixed(1) + ' ly'));
    panel.appendChild(actionRow(
      'Refuel' + (fuelMissing > 0.05 ? '' : ' (tank full)'),
      fuelMissing > 0.05 ? refuelPrice.toFixed(1) + ' CR' : '-',
      fuelMissing > 0.05 && s.cash >= refuelPrice,
      () => actions.refuel && actions.refuel(),
    ));

    // Missiles.
    panel.appendChild(row('Missiles', String(s.missiles)));
    panel.appendChild(actionRow(
      'Buy missile',
      PLAYER.MISSILE_PRICE + ' CR',
      s.cash >= PLAYER.MISSILE_PRICE && s.missiles < 4,
      () => actions.missile && actions.missile(),
    ));

    body.appendChild(panel);

    if (s.legal && s.legal.wanted && s.systemIndex !== undefined) {
      const cost = REP.fineFor(s.player, s.systemIndex);
      const fine = el('div', 'elite-panel');
      fine.appendChild(row('Wanted by', s.legal.label, 'elite-bad'));
      fine.appendChild(actionRow(
        'Pay fine',
        cost + ' CR',
        s.cash >= cost,
        () => actions.payFine && actions.payFine(),
      ));
      body.appendChild(fine);
    }
  }

  function doEquip(item) {
    if (!actions.equip) return;
    if (PLAYER.hasEquipment(currentState.player, item.id)) return notify('Already installed');
    if (currentState.cash < item.price) return notify('Not enough credits');
    actions.equip(item.id);
  }

  /**
   * The status table.
   *
   * Every row carries both current and maximum, because a lone number is
   * meaningless: "Shields 18" tells you nothing about whether that is good.
   */
  function renderStatus(s) {
    const cols = el('div', 'elite-cols');

    // --- Ship -----------------------------------------------------------
    const ship = el('div', 'elite-panel');
    ship.appendChild(el('div', 'elite-row-label', 'SHIP'));
    const hullFrac = s.maxHull > 0 ? s.hull / s.maxHull : 0;
    ship.appendChild(row('Hull', s.hull.toFixed(0) + ' / ' + s.maxHull.toFixed(0)));
    ship.appendChild(bar(hullFrac, hullFrac < 0.3 ? '#ff6a5a' : '#9fe8ff'));
    ship.appendChild(row('Shields', s.shields.toFixed(0) + ' / ' + s.maxShields.toFixed(0)));
    ship.appendChild(bar(s.shields / Math.max(1, s.maxShields), '#9fe8ff'));
    ship.appendChild(row('Energy', s.energy.toFixed(0) + ' / ' + s.maxEnergy.toFixed(0)));
    ship.appendChild(bar(s.energy / Math.max(1, s.maxEnergy), '#ffd27a'));
    ship.appendChild(row('Fuel', s.fuel.toFixed(1) + ' / ' + s.maxFuel.toFixed(1) + ' ly'));
    ship.appendChild(bar(s.fuel / Math.max(0.1, s.maxFuel), '#8affb0'));
    ship.appendChild(row('Cargo', s.cargoUsed + ' / ' + s.hold));
    ship.appendChild(row('Laser', (s.laser || 'pulse').toUpperCase()));
    ship.appendChild(row('Missiles', String(s.missiles)));
    cols.appendChild(ship);

    // --- Career ---------------------------------------------------------
    const career = el('div', 'elite-panel');
    career.appendChild(el('div', 'elite-row-label', 'CAREER'));
    career.appendChild(row('Commander', s.commanderName || 'JAMESON'));
    career.appendChild(row('Rank', (s.rank || 'harmless').toUpperCase()));
    const progress = PLAYER.progressOf(s.player);
    if (progress.next) {
      career.appendChild(row('Next rank', progress.next.toUpperCase()));
      career.appendChild(bar(progress.fraction, '#8affb0'));
      career.appendChild(row('Kills to next', String(progress.needed)));
    } else {
      career.appendChild(row('Kills', String(s.kills)));
    }
    career.appendChild(row('Cash', s.cash.toFixed(1) + ' CR'));
    career.appendChild(row('Systems visited', String(s.visitedCount || 0)));
    cols.appendChild(career);

    body.appendChild(cols);

    // --- Reputation -----------------------------------------------------
    // The caller supplies `standings` as either fully-formed display rows
    // ({id, label, tier}) or bare faction ids, in which case the value comes
    // from the player's own standing table. Normalising here means the game
    // can hand over whichever it has without a second adapter layer.
    const rep = el('div', 'elite-panel');
    rep.appendChild(el('div', 'elite-row-label', 'STANDING'));
    const standings = s.standings || [];
    for (const raw of standings) {
      const st = normaliseStanding(raw, s.player);
      if (!st) continue;
      const r = el('div', 'elite-row');
      r.appendChild(el('span', 'elite-row-label', F.faction(st.id).name));
      const value = el('span', '', st.label);
      if (st.tier === 'allied' || st.tier === 'trusted') value.className = 'elite-good';
      else if (st.tier === 'hostile' || st.tier === 'hunted') value.className = 'elite-bad';
      r.appendChild(value);
      rep.appendChild(r);
    }
    if (rep.childNodes.length > 1) body.appendChild(rep);

    // --- Cargo manifest -------------------------------------------------
    if (s.manifest && s.manifest.length) {
      const m = el('div', 'elite-panel');
      m.appendChild(el('div', 'elite-row-label', 'CARGO MANIFEST'));
      for (const c of s.manifest) {
        m.appendChild(row(c.name, c.quantity + ' t'));
      }
      body.appendChild(m);
    }
  }

  // --- Interaction ------------------------------------------------------

  /** Move the selection in the active list. Called by the game's key handler. */
  function moveSelection(delta) {
    if (tab === 'market') {
      selectedMarket = wrap(selectedMarket + delta, currentMarket.length);
      render();
    } else if (tab === 'equip') {
      selectedEquip = wrap(selectedEquip + delta, PLAYER.EQUIPMENT.length);
      render();
    } else if (tab === 'contracts') {
      const n = contractRowCount();
      if (n > 0) selectedContract = wrap(selectedContract + delta, n);
      render();
    }
  }

  /** Offers plus live contracts, which is the length of the contracts list. */
  function contractRowCount() {
    const s = currentState || {};
    return availableOffers(s).length + ((s.contracts || []).length);
  }

  /** Activate the current selection. */
  function activate() {
    activateInternal(undefined);
  }

  /**
   * Trade exactly one tonne of the current selection.
   *
   * Enter does the whole load, `1` does one tonne. Between them a commander
   * can hold back cash for fuel, top up the last few tonnes of space, or sell
   * just enough to cover a repair without liquidating a position.
   */
  function activateOne() {
    activateInternal(1);
  }

  function activateInternal(tonnes) {
    if (tab === 'market') {
      const row = currentMarket[selectedMarket];
      if (!row) return;
      // Enter on a held commodity sells it: the natural inverse of buying, and
      // it means the market screen supports both directions without a modifier
      // key.
      if (row.held > 0) doSell(row, tonnes);
      else doBuy(row, tonnes);
    } else if (tab === 'equip') {
      doEquip(PLAYER.EQUIPMENT[selectedEquip]);
    } else if (tab === 'contracts') {
      activateContract();
    }
  }

  /**
   * Take the selected offer, or give up the selected contract.
   *
   * Enter on an offer accepts it; Enter on a contract already taken abandons
   * it. The same inverse-of-the-obvious-key idea the market screen uses, so
   * the whole station is driven by one key.
   */
  function activateContract() {
    const s = currentState || {};
    const offers = availableOffers(s);
    if (selectedContract < offers.length) {
      const offer = offers[selectedContract];
      if (!offer) return;
      // No `taken` check here any more: a taken offer is not in this list. The
      // guard that matters lives in `MISSIONS.accept`, which refuses a
      // duplicate id whatever the screen believes.
      if (actions.acceptContract) actions.acceptContract(offer.id);
      return;
    }
    const live = (s.contracts || [])[selectedContract - offers.length];
    if (!live) return;
    if (actions.abandonContract) actions.abandonContract(live.id);
  }

  /** Show a transient message at the top of the screen. */
  let toastTimer = null;
  function notify(text, colour) {
    toast.textContent = text;
    toast.style.color = colour || '#ffd27a';
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  // --- Public API -------------------------------------------------------

  function open(state) {
    currentState = state;
    currentMarket = state.market || [];
    selectedMarket = 0;
    selectedEquip = 0;
    root.classList.add('open');
    setTab(tab);
  }

  function close() {
    root.classList.remove('open');
  }

  function update(state) {
    currentState = state;
    // Market prices drift daily, so refresh them without resetting the
    // selection: resetting on a purchase would make buying multiples painful.
    currentMarket = state.market || [];
    render();
  }

  function isOpen() {
    return root.classList.contains('open');
  }

  setTab('market');

  return {
    root, open, close, update, isOpen,
    moveSelection, activate, activateOne, setTab, notify,
    get tab() { return tab; },
    setTabPublic: setTab,
  };
}

/**
 * The scroll offset that brings a row fully into view.
 *
 * Pure arithmetic over the geometry, so the rule can be tested without a layout
 * engine: Node has no DOM, and a test that needed one would be testing the shim
 * rather than the rule.
 *
 * Returns `scrollTop` unchanged when the row already fits. Scrolling on every
 * render would make the list twitch as prices update, and a list that moves
 * under the cursor is worse than one that is merely long.
 */
export function revealScrollTop(scrollTop, viewHeight, rowTop, rowHeight) {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewHeight) || viewHeight <= 0) {
    return scrollTop;
  }
  if (rowTop < scrollTop) return Math.max(0, rowTop);
  const rowBottom = rowTop + rowHeight;
  if (rowBottom > scrollTop + viewHeight) return rowBottom - viewHeight;
  return scrollTop;
}

// --- Small DOM helpers ----------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function span(text, cls) {
  return el('span', cls || '', text);
}

function row(label, value, valueCls) {
  const r = el('div', 'elite-row');
  r.appendChild(el('span', 'elite-row-label', label));
  r.appendChild(el('span', valueCls || '', value));
  return r;
}

/** A row that looks like a row but is a button. */
function actionRow(label, value, enabled, onClick) {
  const r = el('div', 'elite-row');
  r.style.cursor = enabled ? 'pointer' : 'default';
  r.style.opacity = enabled ? '1' : '0.45';
  r.appendChild(el('span', 'elite-row-label', label));
  const v = el('span', enabled ? 'elite-good' : 'elite-dim', value);
  r.appendChild(v);
  if (enabled && onClick) {
    r.addEventListener('click', onClick);
    r.addEventListener('mouseenter', () => { v.style.textDecoration = 'underline'; });
    r.addEventListener('mouseleave', () => { v.style.textDecoration = 'none'; });
  }
  return r;
}

function bar(fraction, colour) {
  const track = el('div', 'elite-bar');
  const fill = el('div');
  fill.style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + '%';
  if (colour) fill.style.background = colour;
  track.appendChild(fill);
  return track;
}

function wrap(v, len) {
  if (len <= 0) return 0;
  return ((v % len) + len) % len;
}

/**
 * Coerce one entry of the standings list into a display row.
 *
 * Accepts a prepared row or a bare faction id. The label for a bare id comes
 * from the player's standing table via the reputation module, so the view never
 * owns the thresholds - change a tier boundary in one place and the screen
 * follows.
 *
 * Returns null for an entry that cannot be resolved, so a half-built fixture
 * drops out instead of rendering "undefined".
 */
function normaliseStanding(raw, player) {
  if (raw === undefined || raw === null) return null;
  const id = typeof raw === 'object' ? raw.id : raw;
  if (id === undefined || id === null) return null;
  let label = typeof raw === 'object' ? raw.label : undefined;
  let tier = typeof raw === 'object' ? raw.tier : undefined;
  if (label === undefined && player) {
    const value = (player.standing && player.standing[id]) || 0;
    // One ladder, one source. `PLAYER.standingLabel` now delegates to
    // `REP.tierFor`, so the string shown and the mechanic applied can no
    // longer be a step apart. The `techdebt:` note that used to live here
    // described the old duplication and the fix has been applied; its premise
    // ("they agree today") was wrong - they disagreed at -60, -25 and +8.
    label = REP.tierFor(value).label;
    tier = label.toLowerCase();
  }
  if (label === undefined) return null;
  return { id, label, tier: tier || 'neutral' };
}

/** Inject the stylesheet once, however many times this is called. */
function injectCss(host) {
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  if (doc.getElementById('elite-station-css')) return;
  const style = doc.createElement('style');
  style.id = 'elite-station-css';
  style.textContent = STATION_CSS;
  doc.head.appendChild(style);
}

export default { STATION_CSS, createStationUI, revealScrollTop };
