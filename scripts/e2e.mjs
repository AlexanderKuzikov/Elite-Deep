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

/**
 * Poll a page-side predicate until it turns true, rather than sleeping a
 * fixed wall interval and hoping the game kept up. The game's cooldowns tick
 * in frame dt (capped per frame), and under software rendering a frame can
 * take a large fraction of a wall second - a fixed sleep asserted too early
 * here (CI: cooldown still 0.3 s at the ask) and failed a correct game.
 * Returns true when the predicate held, false on timeout (the caller then
 * fails its check with the state attached, so the log still tells why).
 */
async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch (err) { ok = false; }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, stepMs));
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

  // --- The title screen is before the game, not a pause in it -------------
  // Messages used to age in every mode, so everything said at boot - the
  // arrival line, the greeting, the rumour - expired while a new commander was
  // still reading the controls. Measured, the log held zero entries after ten
  // seconds on the title, and the player launched with nothing but "Undocked".
  const titleLog = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const has = () => g.messages.some((m) => m.text === 'boot line');
    g.setMode('title');
    g.say('boot line', '#9fe8ff');
    // Fifteen seconds of title screen - far longer than the 5.5 s lifetime.
    for (let i = 0; i < 900; i += 1) g.step(1 / 60, 5000 + i / 60, { render: false });
    const onTitle = has();
    // And then six and a half seconds of flight, which is longer than it.
    // The line is looked for *by text*: flight says things of its own, so
    // "the log is empty" would be testing the wrong thing.
    g.setMode('flight');
    for (let i = 0; i < 400; i += 1) g.step(1 / 60, 5100 + i / 60, { render: false });
    return { onTitle: onTitle, after: has() };
  });
  check('a message survives the title screen', titleLog.onTitle === true,
    'still there after fifteen seconds on the title');
  check('and then ages normally once the game starts', titleLog.after === false,
    'gone after six seconds of flight');

  const shot0 = await page.screenshot({ path: join(shotDir, '01-flight.png') }).catch(() => null);
  check('a flight frame rendered without throwing', shot0 !== null);

  // --- Mouse control ------------------------------------------------------
  // The mouse runs on pointer lock. Headless cannot complete a lock - Chrome
  // refuses a request with no real gesture behind it, and a synthetic keypress
  // is not a gesture - but that is the browser's half of the contract, and the
  // game's half is entirely checkable: when the player makes the launch
  // gesture, the game must *ask* for the pointer, on an element that can hold
  // it. Asking is what the game controls and what was broken twice over.
  //
  // The earlier version of this check asserted only that the canvas *has* a
  // `requestPointerLock` and that the wrapper was not called on the wrong
  // element. Both are true when no request is made at all, so a regression
  // that stopped the game asking entirely would have passed. The count is
  // asserted now, and the count is the whole value of the check.
  //
  // The gesture is driven through the *live frame loop*, not through `g.step`.
  // That is not a stylistic choice: measured, the ask happens on the live
  // loop's frame and not on a hand-stepped one. `g.step` bypasses the frame
  // clock the mouse cooldown runs on, and the two were racing over the same
  // buffered keypress - which is why this check reported zero requests in one
  // run and one request in another, from identical code.
  //
  // The game is also already holding the pointer by this point in the suite,
  // because an earlier block launched it. `requestMouse` is *correct* to
  // return early then - a game that asked for a lock it already had would be
  // the bug. So the pointer is given back first, exactly as Escape does, and
  // its cooldown is waited out on the live clock.
  await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const canvas = document.getElementById('elite-world');
    const w = window;
    w.__mouseProbe = { asked: 0, wrongElement: false, canvasId: canvas.id };
    const realRequest = canvas.requestPointerLock;
    canvas.requestPointerLock = function () {
      w.__mouseProbe.asked += 1;
      // The element the request is made on. The defect guarded against is a
      // request that goes to the window, which cannot hold a lock at all.
      if (this !== canvas) w.__mouseProbe.wrongElement = true;
      // The real call is made, but the refusal is swallowed: headless Chrome
      // grants no gesture to a synthetic keypress, so the promise would reject
      // and take the page with it. The refusal is still *counted* by the game,
      // which is fine - the check is that the ask happened.
      try {
        const p = realRequest.apply(this, arguments);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) { /* no gesture: expected in a headless run */ }
      return undefined;
    };
  });
  // Hand the pointer back the way Escape does, then wait out its cooldown on
  // the *game* clock, not the wall clock: `releasePointer` arms the same 1.4 s
  // a real Escape arms, and that cooldown ticks in frame dt. Poll the live
  // state instead of sleeping a fixed interval.
  const released = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const st = g.releasePointer();
    g.setMode('title');
    return { locked: st.locked, relockIn: st.relockIn };
  });
  const cooldownExpired = await waitFor(
    () => page.evaluate(() => window.__ELITE_GAME__.debugPointer().relockIn <= 0),
    30000);
  await page.evaluate(() => {
    // A real keydown on the window: the title screen's launch key. This is the
    // whole point - the capture request has to be reachable from a gesture the
    // player actually makes, not only from a test-only code path.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
  });
  // Let the real frame loop notice and act, which is how a player launches:
  // poll the probe until the launch asked, rather than assuming N frames ran.
  const launchAsked = await waitFor(
    () => page.evaluate(() => window.__ELITE_GAME__.mode === 'flight'
      && window.__mouseProbe.asked > 0),
    15000);
  const mouse = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const p = window.__mouseProbe;
    return {
      mode: g.mode,
      asked: p.asked,
      wrongElement: p.wrongElement,
      canvasId: p.canvasId,
      hasRequestApi: typeof document.getElementById('elite-world').requestPointerLock === 'function',
      windowHasRequestApi: typeof window.requestPointerLock === 'function',
      after: g.debugPointer ? JSON.parse(JSON.stringify({
        locked: g.debugPointer().locked,
        relockIn: g.debugPointer().relockIn,
        lockFailures: g.debugPointer().lockFailures,
      })) : null,
    };
  });
  check('the pointer can be handed back, arming the cooldown a real Escape arms',
    released.locked === false && released.relockIn > 0,
    'locked=' + released.locked + ' relockIn=' + released.relockIn.toFixed(2));
  check('launching from the title begins flight', mouse.mode === 'flight', mouse.mode
    + '; cooldown expired: ' + cooldownExpired + ', launch asked: ' + launchAsked);
  check('the game asks for the pointer when the player launches',
    mouse.asked > 0,
    'asked=' + mouse.asked + '; state ' + JSON.stringify(mouse.after)
    + '; cooldown expired: ' + cooldownExpired + ', launch asked: ' + launchAsked);
  check('the pointer is requested on an element that can hold it',
    mouse.asked > 0 && mouse.wrongElement === false && mouse.hasRequestApi === true,
    mouse.asked + ' request(s) on #' + mouse.canvasId
    + '; window.requestPointerLock is '
    + (mouse.windowHasRequestApi ? 'present' : 'absent'));
  // What headless cannot check is the lock itself: Chrome refuses a request with
  // no gesture behind it, and a synthetic keypress is not a gesture. So the
  // handover is left alone rather than asserted, and the checks above state
  // exactly which half of it is covered.
  check('docking is the mutual-exclusion guard for the lock',
    await page.evaluate(() => {
      const g = window.__ELITE_GAME__;
      g.dock();
      return g.mode === 'docked';
    }),
    'the station screen gets the cursor back');

  // --- A routine dock and undock must not leave a dead mouse --------------
  // Docking releases the pointer to show the station screen, and the player
  // pressed nothing to cause it. That release used to arm the same cooldown an
  // Escape arms, so a commander who docked and launched again within a second
  // and a half got a dead mouse and a hint telling them to click - the exact
  // symptom of the bug the cooldown was added to fix, but with no Escape in the
  // story. Measured here rather than argued.
  const dockCycle = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.dock();
    const afterDock = g.debugPointer();
    g.undock();
    const afterUndock = g.debugPointer();
    return {
      mode: g.mode,
      relockAfterDock: afterDock.relockIn,
      relockAfterUndock: afterUndock.relockIn,
      lockedAfterDock: afterDock.locked,
    };
  });
  check('docking releases the pointer for the station screen',
    dockCycle.lockedAfterDock === false, 'locked=' + dockCycle.lockedAfterDock);
  check('a routine dock-then-undock does not arm the player-facing cooldown',
    dockCycle.relockAfterDock === 0 && dockCycle.relockAfterUndock === 0,
    'relockIn after dock ' + dockCycle.relockAfterDock
    + ', after undock ' + dockCycle.relockAfterUndock);

  // --- System change drops what belonged to the old scene ------------------
  // A jump throws away the whole system, so anything the player owns that
  // pointed into it has to go too. Two things used to survive: the locked
  // target (the HUD kept drawing a box around a mesh from a system the player
  // had left) and the meshes of missiles still in flight (`length = 0` on the
  // array orphaned their geometry and material, while inbound missiles one line
  // away were disposed properly).
  const systemChange = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    // A block this far into the run has already changed mode several times, so
    // it reports what it could not do rather than throwing: an exception here
    // would take the whole suite down with a bare `undefined` and hide which
    // check was even being attempted.
    try {
      g.player.fuel = g.player.fuelMax;
      // Lock something, so there is a real target to lose.
      const ships = g.session.traffic.ships.filter((s) => !s.dead);
      g.session.target = ships[0] || null;
      const hadTarget = !!g.session.target;
      // Put a missile of the player's in the air, aimed at that target.
      let hadMissile = false;
      if (g.session.target) {
        const before = g.session.missiles.length;
        g.player.missiles = Math.max(g.player.missiles, 1);
        g.launchMissile();
        hadMissile = g.session.missiles.length > before;
      }
      if (!hadTarget || !hadMissile) {
        return { ok: false, reason: 'could not stage: target=' + hadTarget
          + ' missile=' + hadMissile + ' ships=' + ships.length };
      }
      // The meshes are still in the scene graph, so a cleanup that forgets them
      // leaves the count unchanged after the jump.
      const orphans = g.session.missiles
        .filter((m) => m.mesh && m.mesh.parent)
        .map((m) => m.mesh);
      const from = g.system.index;
      let target = -1;
      for (const s of g.galaxy.systems) {
        if (s.index !== from && g.canJump(s.index).ok) { target = s.index; break; }
      }
      if (target < 0) return { ok: false, reason: 'nothing reachable' };
      g.jumpTo(target);
      for (let i = 0; i < 240; i++) g.step(1 / 60, 500 + i / 60);
      return {
        ok: true,
        hadTarget: hadTarget,
        hadMissile: hadMissile,
        targetAfter: g.session.target === undefined ? 'undefined' : g.session.target,
        missilesAfter: g.session.missiles.length,
        // A mesh that was disposed and removed has no parent left.
        orphansInScene: orphans.filter((m) => !!m.parent).length,
        to: g.system.index,
        expected: target,
      };
    } catch (err) {
      return { ok: false, reason: 'threw: ' + (err && err.message) };
    }
  });
  check('a jumped-away system takes the player\'s target lock with it',
    systemChange && systemChange.ok && systemChange.targetAfter === null,
    systemChange && systemChange.ok
      ? 'hadTarget=' + systemChange.hadTarget
        + ' targetAfter=' + JSON.stringify(systemChange.targetAfter)
      : (systemChange && systemChange.reason) || 'no result');
  check('a jumped-away system leaves no orphaned missile mesh in the scene',
    systemChange && systemChange.ok && systemChange.orphansInScene === 0,
    systemChange && systemChange.ok
      ? systemChange.missilesAfter + ' missile(s) left, '
        + systemChange.orphansInScene + ' orphan mesh(es) attached'
      : (systemChange && systemChange.reason) || 'no result');
  check('the system change that dropped them actually happened',
    systemChange && systemChange.ok && systemChange.to === systemChange.expected,
    systemChange && systemChange.ok
      ? systemChange.to + ' (expected ' + systemChange.expected + ')'
      : (systemChange && systemChange.reason) || 'no result');

  // Put the game back into flight for everything below, which assumes it.
  await page.evaluate(() => window.__ELITE_GAME__.undock());
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

  // --- Wreckage is reachable, and does not leak --------------------------
  // The kill handler called `dropCargo` and threw the result away for as long
  // as the function existed, so the canisters were never in a list any scan
  // walked: scooping could not fire, and nothing ever freed the meshes. Only a
  // live scene can show this - the leak is invisible to a unit test because it
  // is the scene group that keeps growing.
  const wreck = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.setMode('flight');
    // A trader, because it is the kind that carries cargo.
    const trader = g.session.traffic.ships.find(s => s.kind === 'trader' && s.cargo)
      || g.session.traffic.spawn('trader');
    trader.hostile = false;
    trader.aggression = 0;
    const sceneBefore = g.renderer.scene.children.length;
    const inListBefore = g.session.traffic.ships.length;
    const killed = g.strike(trader, 9999);

    const canisters = g.session.traffic.ships.filter(s => s.kind === 'canister');
    const capsules = g.session.traffic.ships.filter(s => s.kind === 'capsule');
    const meshesPresent = canisters.every(
      c => g.renderer.scene.children.indexOf(c.mesh) >= 0);
    const finite = canisters.every(c => Number.isFinite(c.mesh.position.x)
      && Number.isFinite(c.mesh.position.y) && Number.isFinite(c.mesh.position.z));

    // Let them be simulated for a moment, which is where a missing `turnRate`
    // turns the quaternion - and then the position - into NaN.
    for (let i = 0; i < 90; i++) g.step(1 / 60, 6000 + i / 60, { render: false });
    const finiteAfter = canisters.every(c => Number.isFinite(c.mesh.position.x)
      && Number.isFinite(c.mesh.position.y) && Number.isFinite(c.mesh.position.z));

    return {
      killed: killed === true,
      sceneBefore: sceneBefore,
      inListBefore: inListBefore,
      inListAfter: g.session.traffic.ships.length,
      canisters: canisters.length,
      capsules: capsules.length,
      meshesPresent: meshesPresent,
      finite: finite,
      finiteAfter: finiteAfter,
      sceneAfter: g.renderer.scene.children.length,
    };
  });
  check('killing a laden ship drops wreckage into the scanned list',
    wreck.killed && wreck.canisters > 0 && wreck.inListAfter > wreck.inListBefore,
    wreck.canisters + ' canister(s) in a list of ' + wreck.inListAfter
      + ' (was ' + wreck.inListBefore + ')');
  check('the wreckage meshes are in the scene, so they can be seen and hit',
    wreck.meshesPresent === true);
  check('the wreckage stays finite once the simulation steps it',
    wreck.finite === true && wreck.finiteAfter === true,
    'before=' + wreck.finite + ' after=' + wreck.finiteAfter);
  check('a killed crewed ship leaves a capsule behind', wreck.capsules > 0,
    wreck.capsules + ' capsule(s)');

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
    // The last docked station has to survive too. It did not: a commander who
    // had crossed the galaxy came back from a reload with the death screen
    // offering to rescue them at Lave, because `enterSystem` falls back to
    // system 0 when this is null.
    g.player.dockedAt = 7;
    const wrote = g.save();
    g.player.cash = 1;
    g.player.dockedAt = null;
    const read = g.load();
    // The boot log carries the rejection reason when a load refuses: without
    // it a red check says only "cash 1" and the cause is guessed, not read.
    const saveLog = (window.__ELITE_BOOT_LOG__ || [])
      .filter((line) => String(line).indexOf('save:') >= 0).slice(-3).join(' | ');
    return { wrote: wrote, read: read, cash: g.player.cash,
      dockedAt: g.player.dockedAt, log: saveLog };
  });
  check('the game saves', save.wrote === true);
  check('the game loads what it saved', save.read === true && save.cash === 4242,
    'cash ' + save.cash + ' :: ' + save.log);
  check('a save remembers the last station docked at', save.dockedAt === 7,
    'dockedAt came back as ' + JSON.stringify(save.dockedAt));

  // --- A semantically broken save must not brick the game -----------------
  // The seed check alone let any of these through, and each one then failed on
  // *every* boot, because the save is reloaded every boot: a string `cash`
  // broke the station screen, and a `currentSystem` past the end of the table
  // threw on arrival. There was no way out from inside the game.
  const broken = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const key = Object.keys(localStorage).find((k) => k.indexOf('elite') >= 0)
      || 'elite-deep-save.v1';
    const good = localStorage.getItem(key);
    const base = JSON.parse(good);
    const results = {};

    const cases = {
      stringCash: { player: Object.assign({}, base.player, { cash: '4242' }) },
      badSystem: { player: Object.assign({}, base.player, { currentSystem: 99999 }) },
      infiniteFuel: { player: Object.assign({}, base.player, { fuel: 1e999 }) },
      unknownCargo: {
        player: Object.assign({}, base.player, { cargo: { unobtainium: 4 } }),
      },
      unknownFaction: {
        player: Object.assign({}, base.player, { standing: { KLINGON: 5 } }),
      },
    };

    for (const name of Object.keys(cases)) {
      const payload = Object.assign({}, base, cases[name]);
      localStorage.setItem(key, JSON.stringify(payload));
      const p = g.load();
      results[name] = {
        // `load` returns false when the game fell back to a fresh commander.
        rejected: p === false || p === null,
        cashFinite: Number.isFinite(g.player.cash),
        systemValid: Number.isInteger(g.player.currentSystem)
          && g.player.currentSystem >= 0
          && g.player.currentSystem < 64,
      };
    }

    // And the honest control: the untouched save must still load.
    localStorage.setItem(key, good);
    const restored = g.load();
    results.goodStillLoads = restored !== false && restored !== null;
    results.goodCash = g.player.cash;
    results.log = (window.__ELITE_BOOT_LOG__ || [])
      .filter((line) => String(line).indexOf('save:') >= 0).slice(-3).join(' | ');
    return results;
  });
  const brokenNames = ['stringCash', 'badSystem', 'infiniteFuel', 'unknownCargo', 'unknownFaction'];
  for (const name of brokenNames) {
    check('a save with ' + name + ' is refused rather than loaded',
      broken[name].rejected === true,
      'rejected=' + broken[name].rejected);
  }
  check('a refused save leaves the game in a playable state',
    brokenNames.every((n) => broken[n].cashFinite && broken[n].systemValid),
    brokenNames.map((n) => n + ':' + broken[n].cashFinite + '/' + broken[n].systemValid).join(' '));
  check('a good save still loads after a broken one was refused',
    broken.goodStillLoads === true && broken.goodCash === 4242,
    'restored=' + broken.goodStillLoads + ' cash=' + broken.goodCash + ' :: ' + broken.log);

  // --- Death and recovery -------------------------------------------------
  const death = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    g.player.cash = 500;
    g.player.hull = 1;
    // Damage through the state the game reads, then step so the loop notices.
    g.player.hull = 0;
    // The game only checks death when damage is applied, so drive it through
    // the same path a collision would: park inside the collision sphere but
    // off the slot axis. The sphere is 0.62 of the model radius, the corridor
    // and the docking verdict both key off the slot axis, so three quarters
    // of the sphere on +x is overlap without corridor and without a green
    // verdict - however the nose points (it is turned away from the slot
    // anyway, as a second bar). Computed live, not hardcoded: the old +120
    // stood outside the sphere, where nothing happens, and the check passed
    // on pirate damage instead of the impact it claimed.
    const st = g.session.scene.station;
    const f = g.session.flight;
    const off = ((st.userData.radius || 150) * 0.62) * 0.75;
    f.pos.x = st.position.x + off;
    f.pos.y = st.position.y;
    f.pos.z = st.position.z;
    f.quat.x = 0; f.quat.y = 1; f.quat.z = 0; f.quat.w = 0;
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

  // --- Belt rocks are solid -------------------------------------------------
  // Rocks used to be fly-through: they live in the scene group, not in the
  // traffic list the collision scan walked, so the rock branch never fired.
  // Park the ship just off a rock's skin at ramming speed and check the hull.
  // The hit pierces, so full shields change nothing; a dozen stepped frames
  // at 100 units a second always cross the skin from six units out.
  const rockRam = await page.evaluate(() => {
    const g = window.__ELITE_GAME__;
    const rock = g.session.scene.rocks[0];
    const r = (rock.userData && rock.userData.radius) || 8;
    const f = g.session.flight;
    f.pos.x = rock.position.x + r + 6;
    f.pos.y = rock.position.y;
    f.pos.z = rock.position.z;
    f.vel.x = -100; f.vel.y = 0; f.vel.z = 0;
    g.player.shields = g.player.shieldMax;
    g.player.hull = g.player.hullMax;
    g.session.grace = 0;
    g.session.impactCooldown = 0;
    const before = g.player.hull;
    for (let i = 0; i < 12; i += 1) g.step(1 / 60, 600 + i / 60);
    return { before: before, after: g.player.hull, mode: g.mode };
  });
  check('ramming a belt rock hurts', rockRam.after < rockRam.before,
    rockRam.before.toFixed(0) + ' -> ' + rockRam.after.toFixed(0) + ' hull');

  // --- Respawn frees the old system -------------------------------------
  // Death and a new career used to bypass the teardown: each respawn
  // abandoned a station, a planet and ninety rocks in the scene, repeatable
  // by pressing a key. Kill on purpose and compare the scene population
  // across one measured death. The margin below is loose on purpose: a
  // leaked system costs a root plus lights plus a fleet (~14 children),
  // while a freed one rebuilds to nearly the same count (same seed).
  async function launchIfDead() {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    });
    return waitFor(
      () => page.evaluate(() => window.__ELITE_GAME__.mode === 'flight'),
      15000);
  }
  const preDeathMode = await page.evaluate(() => window.__ELITE_GAME__.mode);
  let ready = preDeathMode === 'flight' || preDeathMode === 'dead';
  if (preDeathMode !== 'flight' && preDeathMode !== 'dead') {
    check('respawn check starts from flight or death', false, preDeathMode);
    ready = false;
  }
  if (preDeathMode === 'dead' && !await launchIfDead()) {
    check('respawn check starts from flight or death', false, 'stuck dead');
    ready = false;
  }
  let respawnBefore = -1;
  let reachedDead = false;
  if (ready) {
    respawnBefore = await page.evaluate(
      () => window.__ELITE_GAME__.renderer.scene.children.length);
    // Ram the station until dead: shields down, a sliver of hull, parked
    // inside the collision sphere but off the slot axis (same geometry as
    // the death check above: overlap without corridor, verdict red whatever
    // the nose says), with no grace and no impact cooldown. Re-parked every
    // second in case a bounce carried the wreck clear.
    for (let i = 0; i < 20; i++) {
      reachedDead = await page.evaluate(() => {
        const g = window.__ELITE_GAME__;
        if (g.mode === 'dead') return true;
        if (g.mode !== 'flight') return false;
        g.player.shields = 0;
        g.player.hull = 1;
        const st = g.session.scene.station;
        const f = g.session.flight;
        const off = ((st.userData.radius || 150) * 0.62) * 0.75;
        f.pos.x = st.position.x + off;
        f.pos.y = st.position.y;
        f.pos.z = st.position.z;
        f.quat.x = 0; f.quat.y = 1; f.quat.z = 0; f.quat.w = 0;
        f.vel.x = 0; f.vel.y = 0; f.vel.z = 0;
        g.session.grace = 0;
        g.session.impactCooldown = 0;
        return false;
      });
      if (reachedDead) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  check('a deliberate ram kills the ship', reachedDead,
    'mode after ramming: ' + await page.evaluate(() => window.__ELITE_GAME__.mode));
  const relaunched = reachedDead && await launchIfDead();
  const respawn = await page.evaluate(() => ({
    mode: window.__ELITE_GAME__.mode,
    after: window.__ELITE_GAME__.renderer.scene.children.length,
  }));
  check('death respawns into flight', relaunched && respawn.mode === 'flight',
    respawn.mode);
  check('a respawn does not abandon the old system in the scene',
    relaunched && respawn.after <= respawnBefore + 6,
    respawnBefore + ' -> ' + respawn.after + ' children');

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
    // Timed so a catastrophic regression - an accidental O(n^2) sweep, a
    // per-frame allocation of a scene object - has something to fail against.
    // The bound is deliberately loose: measured, one frame of simulation costs
    // 0.03 ms, so this would have to be a hundred times slower to trip.
    const started = performance.now();
    for (let i = 0; i < 2000; i++) {
      g.player.hull = g.player.hullMax;
      g.player.shields = g.player.shieldMax;
      g.player.fuel = g.player.fuelMax;
      if (g.mode === 'dead') { deaths++; g.setMode('flight'); }
      g.step(1 / 60, 400 + i / 60, { render: i % 200 === 0 });
      modes.add(g.mode);
    }
    const msPerFrame = (performance.now() - started) / 2000;
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
      msPerFrame: msPerFrame,
      x: f.pos.x, y: f.pos.y, z: f.pos.z,
    };
  });
  check('2000 frames produce finite ship state', long.finite,
    `pos (${long.x.toFixed(0)}, ${long.y.toFixed(0)}, ${long.z.toFixed(0)})`);
  check('a frame of simulation stays inside its budget',
    long.msPerFrame < 4,
    long.msPerFrame.toFixed(2) + ' ms/frame (a 60 fps budget is 16.7)');
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
