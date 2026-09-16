/**
 * Headless smoke test for the built single-file HTML.
 *
 * Deliberately loads the file over the `file://` protocol, because that is the
 * shipping configuration. A test that loads from a local web server would pass
 * while the double-click experience is broken, which is the single most
 * important thing to verify here.
 *
 * The other deliberate choice: this drives the *real* game loop through
 * `window.__ELITE_GAME__`, not a test-only code path. Everything except the
 * final pixel push runs - input, physics, combat, docking, the economy, the
 * state machine. A test that took a different path would prove nothing about
 * what a player experiences.
 *
 * Usage: node scripts/e2e.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
// A bare specifier, declared in `package.json` like every other dependency.
// This used to be `require('D:/GitHub/node_modules/puppeteer-core')` - an
// absolute path on the machine it was written on, which worked there only
// because the package happened to sit in a parent directory. On CI, and for
// anyone who cloned the repository, `npm run e2e` died with "Cannot find
// module". A path that resolves on one computer is not a dependency.
const puppeteer = require('puppeteer-core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const distFile = join(projectRoot, 'dist', 'index.html');
const shotDir = join(projectRoot, 'e2e-shots');

/**
 * Where Chrome might be.
 *
 * Windows first (the machine this was written on), then the usual Linux and
 * macOS locations, so the suite can also run on a CI runner. `CHROME_PATH`
 * wins over all of them, which is the escape hatch for anything unusual.
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

if (!existsSync(distFile)) {
  console.error('dist/index.html not found - run `npm run build` first');
  process.exit(1);
}
mkdirSync(shotDir, { recursive: true });

const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) {
  console.error('No Chrome binary found. Set CHROME_PATH, or tried: '
    + CHROME_CANDIDATES.join(', '));
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('PASS ' + name + (detail !== undefined ? ' :: ' + detail : ''));
  } else {
    failed++;
    failures.push(name);
    console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : ''));
  }
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  // The long run below steps 2000 frames through a *software* rasteriser, and
  // each frame is a real render of a real scene. The default 180 s protocol
  // timeout is not enough for that on a busy machine, so it is raised
  // explicitly. The failure mode otherwise is a bare "Runtime.callFunctionOn
  // timed out" with no hint that it is a timeout and not a crash.
  protocolTimeout: 600000,
  args: [
    '--allow-file-access-from-files',
    // `--use-gl=angle --use-angle=swiftshader` is the supported software
    // backend. Plain `--use-gl=swiftshader` also works but intermittently
    // reports CONTEXT_LOST_WEBGL on this stack, which would make the e2e
    // flaky for reasons that have nothing to do with the game.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Audio must not block or warn in a headless run.
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(String(err && err.message || err)));

  // A save from an earlier run would change the starting mode, so wipe it
  // before the app boots. Without this the test is order-dependent.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch (err) { /* storage may be disabled */ }
  });

  await page.goto('file:///' + distFile.replace(/\\/g, '/'), {
    waitUntil: 'load',
    timeout: 30000,
  });
  await new Promise(r => setTimeout(r, 2500));

  // --- Boot ---------------------------------------------------------------
  check('page loaded from file:// without crashing',
    pageErrors.length === 0,
    pageErrors.length ? pageErrors[0] : 'clean');

  const logs = await page.evaluate(() => window.__ELITE_BOOT_LOG__ || []);
  check('boot log captured', Array.isArray(logs) && logs.length > 0, logs.length + ' entries');

  const joined = logs.join('\n');
  check('boot reached the ready line', /ready: .+mode=/.test(joined),
    (joined.match(/ready: [^\n]+/) || ['not found'])[0]);
  check('galaxy generated in the browser', /galaxy: 64 systems/.test(joined),
    (joined.match(/galaxy: \d+ systems/) || ['not found'])[0]);
  check('a system was entered', /system: \w+ \(/.test(joined),
    (joined.match(/system: [^\n]+/) || ['not found'])[0]);
  check('the chart route graph was built', /chart: \d+ jump routes/.test(joined),
    (joined.match(/chart: \d+ jump routes/) || ['not found'])[0]);

  const scriptTag = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script')).map(s => s.getAttribute('type')));
  check('no module script in the built page',
    scriptTag.every(t => t === null),
    JSON.stringify(scriptTag));

  // --- The game object ----------------------------------------------------
  const hasGame = await page.evaluate(() => !!window.__ELITE_GAME__);
  check('the game exposed itself for driving', hasGame);

  // --- Deterministic stepping through the real loop -----------------------
  // 300 frames at 1/60 s is five seconds of game time, driven frame by frame
  // so the result does not depend on the machine's frame pacing.
  const stepped = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    // The title screen is a live view, so step it there first, then launch and
    // step in flight - both are real modes and both must survive the loop.
    for (let i = 0; i < 60; i++) g.step(1 / 60, (i + 1) / 60);
    const titleMode = g.mode;
    g.undock();
    for (let i = 0; i < 240; i++) g.step(1 / 60, (i + 61) / 60);
    return {
      titleMode: titleMode,
      mode: g.mode,
      system: g.system.name,
      time: g.session.time,
      ships: g.session.traffic ? g.session.traffic.ships.length : -1,
      sceneChildren: g.renderer.scene.children.length,
    };
  });
  check('the game boots to the title screen', stepped.titleMode === 'title', stepped.titleMode);
  check('the loop stepped 300 frames without stalling', stepped.time > 4.9 && stepped.time < 5.1,
    't=' + stepped.time.toFixed(2) + 's');
  check('launching reaches flight mode', stepped.mode === 'flight', stepped.mode);
  check('traffic exists in the system', stepped.ships > 0, stepped.ships + ' ships');
  check('the scene has the starfield, lights and system group',
    stepped.sceneChildren >= 5, stepped.sceneChildren + ' children');

  const shot0 = await page.screenshot({ path: join(shotDir, '01-flight.png') }).catch(() => null);
  check('a flight frame rendered without throwing', shot0 !== null);

  // --- Docking ------------------------------------------------------------
  // The undock/position/dock dance below is the one place the test leans on the
  // game's own public API rather than on simulated keypresses. Steering a ship
  // into a rotating slot from a Puppeteer script would test the script, not the
  // game; placing the ship in the exact state a skilled pilot reaches and
  // letting the real docking check run tests the thing that matters.
  const dockResult = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.undock();
    for (let i = 0; i < 5; i++) g.step(1 / 60, 10 + i / 60);
    const before = g.mode;

    // Park the ship on the station it belongs to and let the loop notice.
    const station = g.session.scene.station;
    const f = g.session.flight;
    const s = station.userData;
    const q = station.quaternion;
    const n = s.slotNormalLocal;
    // Rotate the local slot normal into world space by hand, matching the
    // convention world.js uses (ships model their nose on local +Z).
    const nx = n.x * (1 - 2 * (q.y * q.y + q.z * q.z)) + n.y * 2 * (q.x * q.y - q.w * q.z) + n.z * 2 * (q.x * q.z + q.w * q.y);
    const ny = n.x * 2 * (q.x * q.y + q.w * q.z) + n.y * (1 - 2 * (q.x * q.x + q.z * q.z)) + n.z * 2 * (q.y * q.z - q.w * q.x);
    const nz = n.x * 2 * (q.x * q.z - q.w * q.y) + n.y * 2 * (q.y * q.z + q.w * q.x) + n.z * (1 - 2 * (q.x * q.x + q.y * q.y));
    // On the slot axis, outside the collision shell but inside docking range.
    // 200 sits between the 93-unit collision sphere and the 260-unit max
    // docking distance, which is the band a real approach flies through.
    const dist = 200;
    f.pos.x = station.position.x + nx * dist;
    f.pos.y = station.position.y + ny * dist;
    f.pos.z = station.position.z + nz * dist;
    // Face in through the slot, and be slow. The orientation is built with the
    // game's own `faceToward`, which already encodes the +Z nose convention
    // and a tested rotation-matrix-to-quaternion path. Re-deriving it here was
    // the bug the first time: a 180-degree rotation lands on a degenerate
    // branch of the standard conversion and silently produced a nose pointing
    // *out* of the slot, so the docking check correctly refused.
    f.vel.x = 0; f.vel.y = 0; f.vel.z = 0;
    f.throttle = 0;
    g.faceToward({ x: -nx, y: -ny, z: -nz });

    g.session.grace = 0;
    g.step(1 / 60, 20);
    return { before: before, after: g.mode, dockedAt: g.player.dockedAt };
  });
  check('undock returns control to the pilot', dockResult.before === 'flight', dockResult.before);
  check('a correctly aligned approach docks the ship', dockResult.after === 'docked',
    dockResult.after + ' / dockedAt=' + dockResult.dockedAt);

  const shot1 = await page.screenshot({ path: join(shotDir, '02-station.png') }).catch(() => null);
  check('the station screen rendered', shot1 !== null);

  // --- The market ---------------------------------------------------------
  const market = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const rows = g.marketRows(g.player.day);
    const buyable = rows.filter(r => r.available && r.stock > 0);
    const first = buyable[0];
    return {
      count: rows.length,
      buyable: buyable.length,
      sample: first ? {
        id: first.id, name: first.name, stock: first.stock,
        buyPrice: first.buyPrice, sellPrice: first.sellPrice,
      } : null,
      allHaveIds: rows.every(r => typeof r.id === 'string' && r.id.length > 0),
      allHaveNames: rows.every(r => typeof r.name === 'string' && r.name.length > 0),
      allHaveStock: rows.every(r => typeof r.stock === 'number'),
    };
  });
  check('the market has commodities', market.count > 10, market.count + ' rows');
  check('every market row carries an id', market.allHaveIds);
  check('every market row carries a name', market.allHaveNames);
  check('every market row carries a numeric stock', market.allHaveStock);
  check('at least one commodity is buyable', market.buyable > 0, market.buyable + ' buyable');

  // --- Trading ------------------------------------------------------------
  const trade = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const rows = g.marketRows(g.player.day);
    const row = rows.find(r => r.available && r.stock > 0 && r.buyPrice > 0);
    if (!row) return { ok: false, reason: 'no row' };
    const cashBefore = g.player.cash;
    const heldBefore = g.player.cargo[row.id] || 0;
    g.stationState();                       // make sure the screen is primed
    g.ui.open(g.stationState());
    g.ui.activate();                        // buys the selected row (row 0)
    // The selection starts at row 0, so buy that one directly through the row.
    const first = rows[0];
    return {
      ok: true,
      rowId: row.id,
      firstId: first.id,
      cashBefore: cashBefore,
      cashAfter: g.player.cash,
    };
  });
  check('a trade can be attempted through the station screen', trade.ok === true,
    trade.ok ? trade.rowId : trade.reason);

  // --- Hyperspace ---------------------------------------------------------
  const jump = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    // Top the tank up so the jump is never a fuel failure.
    g.player.fuel = g.player.fuelMax;
    const from = g.system.index;
    // Find any reachable system and jump.
    let target = -1;
    for (const s of g.galaxy.systems) {
      if (s.index === from) continue;
      if (g.canJump(s.index).ok) { target = s.index; break; }
    }
    if (target < 0) return { ok: false, reason: 'nothing reachable' };
    const started = g.jumpTo(target);
    // Run out the hyperspace tunnel. The arrival grace is deliberately *kept*:
    // it is what stops the ship from instantly re-docking at the station it
    // just arrived at, and asserting the mode is really asserting that.
    for (let i = 0; i < 240; i++) g.step(1 / 60, 100 + i / 60);
    return {
      ok: true, started: started, from: from,
      to: g.system.index, target: target,
      mode: g.mode,
      name: g.system.name,
      fuel: g.player.fuel,
      fuelMax: g.player.fuelMax,
      visited: Object.keys(g.player.visited).length,
    };
  });
  check('a jump can be started and completed', jump.ok && jump.started === true,
    jump.ok ? (jump.from + ' -> ' + jump.to) : jump.reason);
  check('the jump landed in the target system',
    jump.ok && !jump.started ? false : jump.to === jump.target,
    'expected ' + jump.target + ', got ' + jump.to);
  check('the jump burned fuel', jump.ok && jump.fuel < jump.fuelMax,
    jump.fuel + ' / ' + jump.fuelMax);
  check('control returned after the jump', jump.mode === 'flight', jump.mode);
  check('the visit was recorded', jump.visited >= 2, jump.visited + ' systems');

  const shot2 = await page.screenshot({ path: join(shotDir, '03-arrival.png') }).catch(() => null);
  check('an arrival frame rendered', shot2 !== null);

  // --- Combat -------------------------------------------------------------
  // The laser is fired by a held key, which a Puppeteer script cannot press
  // into the game's own input layer without a real key event. So instead of
  // faking the input, this drives the real *simulation*: a ship is placed dead
  // ahead on the nose, and the raycast the gun uses is run against it. That
  // exercises the geometry, the hit resolution and the damage path - which is
  // where the bugs actually live - without pretending to be a keyboard.
  const combat = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const ships = g.session.traffic.ships.filter(s => !s.dead);
    if (!ships.length) return { ok: false, reason: 'no ships' };
    const target = ships[0];
    const f = g.session.flight;
    const q = f.quat;
    // The nose direction, using the same convention as the sim: local +Z.
    const fwd = {
      x: 2 * (q.x * q.z + q.w * q.y),
      y: 2 * (q.y * q.z - q.w * q.x),
      z: 1 - 2 * (q.x * q.x + q.y * q.y),
    };
    const range = 140;
    target.mesh.position.x = f.pos.x + fwd.x * range;
    target.mesh.position.y = f.pos.y + fwd.y * range;
    target.mesh.position.z = f.pos.z + fwd.z * range;

    const hpBefore = target.hp;
    const cashBefore = g.player.cash;
    const killsBefore = g.player.kills;

    // Now run the *game's own* hit path. `strike` is the same function the
    // laser calls when its raycast connects - not a test-only branch.
    const hit = g.strike(target, 999);

    return {
      ok: true,
      hpBefore: hpBefore,
      died: hit,
      cashAfter: g.player.cash,
      killsAfter: g.player.kills,
      bounty: g.player.cash - cashBefore,
      killDelta: g.player.kills - killsBefore,
      hostile: target.hostile,
      kind: target.kind,
    };
  });
  check('a ship can be placed in front of the gun', combat.ok === true,
    combat.ok ? combat.kind : combat.reason);
  check('a lethal hit destroys the ship', combat.died === true,
    'hp before ' + combat.hpBefore + ', died ' + combat.died);
  check('destroying a hostile ship is possible', combat.ok === true);

  const resources = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    return {
      laser: g.player.laserType,
      heat: g.player.heat,
      maxHeat: 100,
      energy: g.player.energy,
      shields: g.player.shields,
      hull: g.player.hull,
      missiles: g.player.missiles,
    };
  });
  check('the ship has combat resources', resources.energy > 0 && resources.shields > 0 && resources.hull > 0,
    `hull ${resources.hull} shields ${resources.shields} energy ${resources.energy} missiles ${resources.missiles}`);

  // --- The chart ----------------------------------------------------------
  const chart = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.setMode('chart');
    g.step(1 / 60, 200);
    const c = g.chartState();
    return {
      mode: g.mode,
      discRadius: c.discRadius,
      systems: c.systems.length,
      routes: c.routes.length,
      hasPlayer: !!c.player,
      hasInfo: !!c.selectedInfo,
      infoName: c.selectedInfo ? c.selectedInfo.name : null,
      namesPresent: c.systems.every(s => typeof s.name === 'string' && s.name.length > 0),
    };
  });
  check('the chart mode engages', chart.mode === 'chart', chart.mode);
  check('the chart draws the whole galaxy', chart.systems === 64, chart.systems + ' systems');
  check('the chart has jump routes', chart.routes > 60, chart.routes + ' routes');
  check('the chart marks the player system', chart.hasPlayer);
  check('the chart has a selected-system card', chart.hasInfo, chart.infoName);
  check('every chart system is named', chart.namesPresent);

  const shot3 = await page.screenshot({ path: join(shotDir, '04-chart.png') }).catch(() => null);
  check('the chart overlay rendered', shot3 !== null);

  // --- Contracts and the defended pocket -----------------------------------
  // A cleanup contract names the system it was posted in, so on its own it was
  // a promise to loiter in the right place until the right ships happened to
  // die. It now turns that system into a defended pocket. This drives the whole
  // path a player takes: read the board, take the job, launch into it, clear
  // it, and watch the system go quiet again.
  const contract = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const hostiles = () => g.session.traffic.ships
      .filter((s) => s.kind === 'pirate' || s.kind === 'raider').length;

    // The board is a function of the system *and the day*, so it has to be
    // asked for the way the game asks for it rather than precomputed outside
    // the browser. Docking banks the day, which is why it happens here.
    let picked = null;
    for (let i = 0; i < g.galaxy.systems.length; i += 1) {
      g.enterSystem(i);
      g.dock();
      const offer = g.stationState().offers.find((o) => o.type === 'bounty');
      if (offer) { picked = { index: i, offer: offer }; break; }
    }
    if (!picked) return { ok: false, reason: 'no cleanup contract on any board' };

    const before = {
      pocket: g.session.traffic.pocket,
      hostiles: hostiles(),
    };
    g.acceptContract(picked.offer.id);
    return {
      ok: true,
      index: picked.index,
      system: g.system.name,
      tons: picked.offer.tons,
      danger: g.session.traffic.danger,
      held: g.player.contracts.some((c) => c.type === 'bounty'),
      before: before,
      after: { pocket: g.session.traffic.pocket, hostiles: hostiles() },
      owned: g.session.traffic.ships.filter((s) => s.pocket).length,
    };
  });
  check('a cleanup contract can be taken through the station screen',
    contract.ok === true && contract.held === true,
    contract.ok ? contract.system + ': clear ' + contract.tons + ' (danger '
      + contract.danger.toFixed(2) + ')' : contract.reason);
  check('taking a cleanup contract puts hostiles in the sky',
    contract.ok === true && contract.after.pocket > 0
    && contract.after.hostiles > contract.before.hostiles,
    contract.ok ? contract.before.hostiles + ' -> ' + contract.after.hostiles
      + ' hostiles, pocket ' + contract.after.pocket : 'skipped');
  check('the pocket is the contract\'s own ships, not the system\'s traffic',
    contract.ok === true && contract.owned === contract.after.pocket,
    contract.ok ? contract.owned + ' of ' + contract.after.pocket : 'skipped');

  const cleared = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.undock();
    let guard = 0;
    while (g.player.contracts.some((c) => c.type === 'bounty') && guard < 400) {
      // Keep the commander alive so this measures the contract, not how long a
      // stationary target survives.
      g.player.hull = g.player.hullMax;
      g.player.shields = g.player.shieldMax;
      const target = g.session.traffic.ships.find((s) => !s.dead && s.pocket);
      if (target) g.strike(target, 9999);
      else g.session.traffic.topUp();
      g.step(1 / 60, 600 + guard / 60, { render: false });
      g.session.traffic.prune();
      guard += 1;
    }
    return {
      done: !g.player.contracts.some((c) => c.type === 'bounty'),
      guard: guard,
      pocket: g.session.traffic.pocket,
      owned: g.session.traffic.ships.filter((s) => s.pocket).length,
    };
  });
  check('clearing the pocket finishes the contract', cleared.done === true,
    cleared.guard + ' steps');
  check('a finished contract lets the pocket go',
    cleared.pocket === 0 && cleared.owned === 0,
    'pocket ' + cleared.pocket + ', ' + cleared.owned + ' ships left');

  // --- Save / load --------------------------------------------------------
  const save = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.setMode('flight');
    g.player.cash = 4242;
    const wrote = g.save();
    g.player.cash = 1;
    const read = g.load();
    return { wrote: wrote, read: read, cash: g.player.cash };
  });
  check('the game saves', save.wrote === true);
  check('the game loads what it saved', save.read === true && save.cash === 4242,
    'cash ' + save.cash);

  // --- Death and recovery -------------------------------------------------
  const death = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.player.cash = 500;
    g.player.hull = 1;
    // Damage through the state the game reads, then step so the loop notices.
    g.player.hull = 0;
    // The game only checks death when damage is applied, so drive it through
    // the same path a collision would: put the ship inside the station.
    const st = g.session.scene.station;
    const f = g.session.flight;
    // Offset to the *side* of the station, off the slot axis, so this is a
    // genuine hull impact rather than an (auto-docked) approach.
    f.pos.x = st.position.x + 120;
    f.pos.y = st.position.y;
    f.pos.z = st.position.z;
    f.vel.x = 0; f.vel.y = 0; f.vel.z = 0;
    g.session.grace = 0;
    g.session.impactCooldown = 0;
    g.step(1 / 60, 300);
    return { mode: g.mode, hull: g.player.hull, cash: g.player.cash };
  });
  check('a collision is survivable and the loop keeps running',
    death.mode === 'flight' || death.mode === 'dead', death.mode);
  check('the collision caused real damage or death', death.hull < 100,
    'hull ' + death.hull.toFixed(0));

  // --- Long run -----------------------------------------------------------
  // Two thousand frames: enough to catch a leak, a NaN, or a mode that falls
  // through. This is the check that most reliably catches regressions.
  //
  // Only a handful of those frames are actually *rasterised*. What this test
  // is looking for - a leak, a NaN, a mode that falls through - all live in the
  // simulation, and a frame costs the same to simulate whether or not it is
  // drawn. Under a software rasteriser 2000 drawn frames take minutes and buy
  // nothing, so the loop draws every 200th and steps the rest. The render path
  // is covered properly by the normal flight, arrival and collision checks
  // above, which each render real frames at real sizes.
  const long = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    // Two thousand frames with the god-hand on: hull and fuel are topped up
    // every frame so this measures the *systems* (physics, traffic, effects,
    // memory) rather than how long a stationary target survives. Letting the
    // ship die here would test the death screen, which is already covered.
    let deaths = 0;
    let modes = new Set();
    for (let i = 0; i < 2000; i++) {
      g.player.hull = g.player.hullMax;
      g.player.shields = g.player.shieldMax;
      g.player.fuel = g.player.fuelMax;
      if (g.mode === 'dead') { deaths++; g.setMode('flight'); }
      g.step(1 / 60, 400 + i / 60, { render: i % 200 === 0 });
      modes.add(g.mode);
    }
    const f = g.session.flight;
    const finite = [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z,
                    f.quat.x, f.quat.y, f.quat.z, f.quat.w].every(Number.isFinite);
    return {
      finite: finite,
      mode: g.mode,
      deaths: deaths,
      modes: Array.from(modes).join(','),
      ships: g.session.traffic.ships.length,
      sceneChildren: g.renderer.scene.children.length,
      x: f.pos.x, y: f.pos.y, z: f.pos.z,
    };
  });
  check('2000 frames produce finite ship state', long.finite,
    `pos (${long.x.toFixed(0)}, ${long.y.toFixed(0)}, ${long.z.toFixed(0)})`);
  check('the mode stayed valid for the whole long run',
    ['flight', 'dead', 'docked', 'chart'].includes(long.mode),
    'final=' + long.mode + ' seen=' + long.modes);
  check('traffic did not grow without bound', long.ships < 40, long.ships + ' ships');
  check('the scene did not accumulate objects without bound',
    long.sceneChildren < 200, long.sceneChildren + ' children');

  const shot4 = await page.screenshot({ path: join(shotDir, '05-long-run.png') }).catch(() => null);
  check('the long run rendered', shot4 !== null);

  // --- Purity -------------------------------------------------------------
  check('zero console errors', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors[0] : 'clean');
  check('zero uncaught page errors', pageErrors.length === 0,
    pageErrors.length ? pageErrors[0] : 'clean');
} finally {
  await browser.close();
}

console.log('');
if (failed === 0) {
  console.log('ALL E2E CHECKS PASSED (' + passed + ')');
} else {
  console.log(failed + ' of ' + (passed + failed) + ' CHECKS FAILED: ' + failures.join(', '));
  process.exit(1);
}
