// inject_sensors.js
// Replay CSV su emulatore Android via Appium (UiAutomator2) usando la console sensori.
// Uso: node inject_sensors.js <app> <file.csv>
// <app> ∈ { run, tayutau, accupedo, walklogger, forlani, myapp }

require("dotenv").config();
const wdio = require("webdriverio");
const fs = require("fs");
const { parse } = require("csv-parse");

/* ========== ENV & COSTANTI ========== */

const AXIS_MAP  = (process.env.AXIS_MAP  || "XYZ").toUpperCase(); // p.es. ZXY
const AXIS_SIGN = (process.env.AXIS_SIGN || "+++");

const CSV_UNITS       = (process.env.CSV_UNITS || "ms2").toLowerCase();      // acc: ms2 | g
const CSV_GYRO_UNITS  = (process.env.CSV_GYRO_UNITS || "rad_s").toLowerCase(); // rad_s | dps
const CSV_MAG_UNITS   = (process.env.CSV_MAG_UNITS  || "uT").toLowerCase();    // uT | t | mgauss
const CSV_HAS_HEADER  = envBool("CSV_HAS_HEADER", true);
const TIMES_ARE_MS    = envBool("CSV_TIMES_ARE_MS", true); // false => ns
const CSV_LAYOUT      = (process.env.CSV_LAYOUT || "").trim().toLowerCase();  // es. "t,ax,ay,az,gx,gy,gz,mx,my,mz"

// Sempre iniettiamo gyro & mag (come richiesto)
const INJECT_GYRO     = true;
const INJECT_MAG      = true;

const PRE_ROLL_MS     = Number(process.env.PRE_ROLL_MS || 0);
const LOOP_REPEATS    = Number(process.env.LOOP_REPEATS || 1);
const LOOP_GAP_MS     = Number(process.env.LOOP_GAP_MS || 0);
const LOG_EVERY_N     = Number(process.env.LOG_EVERY_N || 100);

// Se true scarta timestamp non monotoni (dup o indietro nel tempo)
const DROP_NON_MONOTONIC = envBool("DROP_NON_MONOTONIC", true);

const G = 9.80665;

// APK paths (sovrascrivibili da .env)
const myApplicationPath = process.env.APP_MYAPP_APK      || "C:/Users/Utente/AndroidStudioProjects/MyApplication/app/build/outputs/apk/debug/app-debug.apk";
const runtasticPath     = process.env.APP_RUN_APK        || "C:/Users/Utente/Downloads/Runtastic Pedometer PRO_1.6.2_apkcombo.com.apk";
const tayutauPath       = process.env.APP_TAYUTAU_APK    || "C:/Users/Utente/Downloads/pedometer-5-47.apk";
const accupedoPath      = process.env.APP_ACCUPEDO_APK   || "C:/Users/Utente/Downloads/accupedo-pedometer-9-1-5-1.apk";
const walkloggerPath    = process.env.APP_WALKLOGGER_APK || "C:/Users/Utente/Downloads/walklogger-pedometer.apk";
const forlaniPath       = process.env.APP_FORLANI_APK    || "C:/Users/frafo/OneDrive/Desktop/TESI LAM/release/steplab-v1.0.apk";

/* ========== HELPERS ========== */

function envBool(name, def) { const v = process.env[name]; if (v == null) return def; return /^(1|true|yes|y|on)$/i.test(v); }
function isAbsolute(p)      { return /^([A-Za-z]:\\|\/)/.test(p); }

function assertAxisSettings() {
  if (!/^[XYZ]{3}$/.test(AXIS_MAP))  throw new Error(`AXIS_MAP non valido: "${AXIS_MAP}" (atteso: es. XYZ, ZXY)`);
  if (!/^[+\-]{3}$/.test(AXIS_SIGN)) throw new Error(`AXIS_SIGN non valido: "${AXIS_SIGN}" (atteso: tre simboli +/-, es. +++)`);
}

function mapAxes([x, y, z]) {
  const pick = (c) => (c === "X" ? x : c === "Y" ? y : z);
  const sx = AXIS_SIGN[0] === "-" ? -1 : 1;
  const sy = AXIS_SIGN[1] === "-" ? -1 : 1;
  const sz = AXIS_SIGN[2] === "-" ? -1 : 1;
  return [sx * pick(AXIS_MAP[0]), sy * pick(AXIS_MAP[1]), sz * pick(AXIS_MAP[2])];
}
function scaleAccel([x, y, z]) { const s = (CSV_UNITS === "g") ? G : 1; return [x * s, y * s, z * s]; }          // -> m/s^2
function scaleGyro ([x, y, z]) { const s = (CSV_GYRO_UNITS === "dps") ? (Math.PI / 180) : 1; return [x*s,y*s,z*s]; } // -> rad/s
function scaleMag  ([x, y, z]) { let s = 1; if (CSV_MAG_UNITS === "t") s=1e6; else if (CSV_MAG_UNITS === "mgauss") s=0.1; return [x*s,y*s,z*s]; } // -> µT

function isFiniteNum(v){ const n = Number(v); return Number.isFinite(n); }
function numOrZero (v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

/* ====== CSV LAYOUT ====== */
const LAYOUT_FIELDS = ["t","timestamp","ax","ay","az","gx","gy","gz","mx","my","mz"];
function getLayoutFromEnv() {
  if (!CSV_LAYOUT) return null;
  const parts = CSV_LAYOUT.split(",").map(s => s.trim());
  const m = {};
  parts.forEach((name, idx) => {
    const key = name.toLowerCase();
    if (!LAYOUT_FIELDS.includes(key)) throw new Error(`CSV_LAYOUT contiene campo non valido "${name}"`);
    m[key] = idx;
  });
  return m;
}
function getLayoutFromHeader(headerRow) {
  if (!headerRow) return null;
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    if (LAYOUT_FIELDS.includes(key)) map[key] = i;
  });
  if ((map.t != null || map.timestamp != null) && map.ax != null && map.ay != null && map.az != null) return map;
  return null;
}
function detectCSVLayout(row) {
  const lastIdx = row.length - 1;
  const first = Number(row[0]);
  const last  = Number(row[lastIdx]);
  const looksTime = (v) => Number.isFinite(v) && (v > 1e9 || (!TIMES_ARE_MS && v > 1e6) || (TIMES_ARE_MS && v > 1e3));

  let tIdx = null;
  if (looksTime(last))  tIdx = lastIdx;
  else if (looksTime(first)) tIdx = 0;
  else {
    // fallback: colonna con valore max
    let bestI = 0, bestV = -Infinity;
    for (let i = 0; i < row.length; i++) { const v = Number(row[i]); if (Number.isFinite(v) && v > bestV) { bestV = v; bestI = i; } }
    tIdx = bestI;
  }
  const idx = { t: tIdx, ax:null, ay:null, az:null, gx:null, gy:null, gz:null, mx:null, my:null, mz:null };
  const numericIdx = [];
  for (let i = 0; i < row.length; i++) if (i !== tIdx && isFiniteNum(row[i])) numericIdx.push(i);
  const order = ["ax","ay","az","gx","gy","gz","mx","my","mz"];
  for (let j = 0; j < order.length && j < numericIdx.length; j++) idx[order[j]] = numericIdx[j];
  return idx;
}
function pickTimestamp(row, idxMap) {
  const tIdx = (idxMap.timestamp != null) ? idxMap.timestamp : idxMap.t;
  const raw = Number(row[tIdx]);
  if (!Number.isFinite(raw)) return NaN;
  return TIMES_ARE_MS ? raw : (raw / 1e6); // ns -> ms
}
function pickVec(row, idxMap, kx, ky, kz) {
  const x = numOrZero(row[idxMap[kx] ?? -1]);
  const y = numOrZero(row[idxMap[ky] ?? -1]);
  const z = numOrZero(row[idxMap[kz] ?? -1]);
  return [x, y, z];
}

/* ========== CHECK EMULATORE ========== */
async function ensureEmulator(driver) {
  try {
    await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: 'help' }]);
  } catch (e) {
    throw new Error(
      'Target non è un emulatore OPPURE manca --allow-insecure " *:emulator_console " sul server Appium. ' +
      'Avvia Appium con: appium --allow-insecure "*:emulator_console". Dettagli: ' + (e?.message || e)
    );
  }
}

/* ========== INIEZIONE ESATTA DAL CSV (stream) ========== */
/**
 * Legge il CSV una volta, costruisce la sequenza (tMs, acc, gyr, mag) preservando i valori,
 * e inietta esattamente ai tempi indicati (scheduler assoluto). Nessuna interpolazione.
 */
async function injectExactFromCsv(driver, csvPath) {
  // 1) parse layout (header/env/autodetect) + raccolta samples
  const parser = parse({ delimiter: ",", from_line: 1, relax_column_count: true, skip_empty_lines: true });

  const stream = fs.createReadStream(csvPath).pipe(parser);
  let idxMap = getLayoutFromEnv();
  let rowIdx = 0;
  let firstT = null;
  let wall0 = 0;
  let lastT = -Infinity;
  let count = 0;

  // loop su ciascuna riga
  for await (const row of stream) {
    rowIdx++;
    if (!row || row.length < 4) continue;

    // header?
    if (rowIdx === 1 && CSV_HAS_HEADER && !idxMap) {
      const fromHeader = getLayoutFromHeader(row);
      if (fromHeader) { idxMap = fromHeader; continue; }
    }

    // autodetect alla prima riga utile
    if (!idxMap) idxMap = detectCSVLayout(row);

    // estrai timestamp & vettori (con unità + rimappatura)
    const tMs = pickTimestamp(row, idxMap);
    if (!Number.isFinite(tMs)) continue;
    if (DROP_NON_MONOTONIC && tMs <= lastT) continue;

    const acc = mapAxes(scaleAccel(pickVec(row, idxMap, "ax","ay","az")));
    const gyr = mapAxes(scaleGyro (pickVec(row, idxMap, "gx","gy","gz")));
    const mag = mapAxes(scaleMag  (pickVec(row, idxMap, "mx","my","mz")));

    // inizializzazione timing assoluto
    if (firstT == null) {
      firstT = tMs;
      wall0 = Date.now() + PRE_ROLL_MS;
      if (PRE_ROLL_MS > 0) await sleep(PRE_ROLL_MS);
    }

    // attesa fino all'istante ideale (nessun clamp/min spacing)
    const due = wall0 + (tMs - firstT);
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);

    // invio in UN'UNICA CHIAMATA (tre righe)
    const cmd =
      `sensor set acceleration ${acc[0]}:${acc[1]}:${acc[2]}\n` +
      `sensor set gyroscope ${gyr[0]}:${gyr[1]}:${gyr[2]}\n` +
      `sensor set magnetic-field ${mag[0]}:${mag[1]}:${mag[2]}`;
    await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: cmd }]);

    count++;
    if (LOG_EVERY_N > 0 && count % LOG_EVERY_N === 0) {
      console.log(`Inject ${count} samples (exact stream) @t=${Math.round(tMs)}ms`);
    }

    lastT = tMs;
  }
}

/* ========== UI SIMULATIONS (safe) ========== */

async function SimulateRUN(driver) {
  await sleep(600);
  try { await driver.$(`android=new UiSelector().text("REMIND ME LATER").className("android.widget.Button")`).click(); } catch {}
  await sleep(300);
  try { await driver.$(`android=new UiSelector().text("SKIP")`).click(); } catch {}
  await sleep(300);
  try { await driver.$(`android=new UiSelector().textContains("START WORKOUT")`).click(); } catch {}
}

async function SimulateTayutau(driver) { try { await driver.$(`android=new UiSelector().textMatches("(?i)start")`).click(); } catch {} }

async function SimulateForlani(driver) {
  try { await driver.$(`android=new UiSelector().text("ENTER CONFIGURATION")`).click(); } catch {}
  try {
    const scrollSel = `android=new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("Butterworth Filter")`;
    await driver.$(scrollSel);
  } catch {}
  try { await driver.$(`android=new UiSelector().textContains("Butterworth Filter")`).click(); } catch {}
  try { await driver.$(`android=new UiSelector().textContains("START PEDOMETER")`).click(); } catch {}
}

async function SimulateAccupedo()  { /* no-op */ }

async function SimulateWalklogger(){ /* no-op */ }

/* ========== SELEZIONE APP & SIMULAZIONE ========== */

function selectApp(arg) {
  switch (arg) {
    case "run":        return runtasticPath;
    case "tayutau":    return tayutauPath;
    case "accupedo":   return accupedoPath;
    case "walklogger": return walkloggerPath;
    case "forlani":    return forlaniPath;
    case "myapp":      return myApplicationPath;
    default:
      console.error("App non riconosciuta:", arg);
      process.exit(2);
  }
}
function selectSimulation(arg) {
  switch (arg) {
    case "run":        return SimulateRUN;
    case "tayutau":    return SimulateTayutau;
    case "accupedo":   return SimulateAccupedo;
    case "walklogger": return SimulateWalklogger;
    case "forlani":    return SimulateForlani;
    case "myapp":      return async () => {};
    default:           return async () => {}; // evita "simulate is not a function"
  }
}

/* ========== MAIN ========== */

async function main() {
  assertAxisSettings();

  const appArg = (process.argv[2] || "").toLowerCase();
  const csvArg = process.argv[3];
  if (!appArg || !csvArg) {
    console.log("Uso: node inject_sensors.js <app> <file.csv>");
    console.log("app ∈ { run, tayutau, accupedo, walklogger, forlani, myapp }");
    process.exit(2);
  }

  const app = selectApp(appArg);
  const simulate = selectSimulation(appArg);
  const csvPath = isAbsolute(csvArg) ? csvArg : (`./${csvArg}`);
  if (!fs.existsSync(csvPath)) { console.error("File CSV non trovato:", csvPath); process.exit(3); }

  const opts = {
    hostname: process.env.APPIUM_HOST || "127.0.0.1",
    port: Number(process.env.APPIUM_PORT || 4723),
    path: process.env.APPIUM_BASE_PATH || "/wd/hub",
    capabilities: {
      platformName: "Android",
      "appium:deviceName": process.env.DEVICE_NAME || "Android Emulator",
      "appium:avd": process.env.AVD_NAME || undefined,
      "appium:avdLaunchTimeout": Number(process.env.AVD_LAUNCH_TIMEOUT || 240000),
      "appium:app": app,
      "appium:automationName": process.env.AUTOMATION_NAME || "UiAutomator2",
      "appium:newCommandTimeout": Number(process.env.NEW_COMMAND_TIMEOUT || 600),
      "appium:autoGrantPermissions": envBool("AUTO_GRANT_PERMISSIONS", true),
      "appium:noReset": envBool("NO_RESET", true),
      // NB: l'abilitazione reale è sul server (CLI)
      "appium:allowInsecure": ["emulator_console"]
    }
  };

  console.log("== Avvio sessione ==");
  console.log("APK:", app);
  console.log("CSV:", csvPath);

  const driver = await wdio.remote(opts);

  try {
    await ensureEmulator(driver);
    await simulate(driver);

    console.log("== Inizio iniezione esatta (stream) ==");
    for (let loop = 0; loop < Math.max(1, LOOP_REPEATS); loop++) {
      await injectExactFromCsv(driver, csvPath);
      if (loop < LOOP_REPEATS - 1 && LOOP_GAP_MS > 0) await sleep(LOOP_GAP_MS);
    }
    console.log("== Iniezione completata ==");
  } finally {
    try { await sleep(500); await driver.deleteSession(); }
    catch (e) { console.warn("Chiusura sessione:", e?.message || e); }
  }
}

/* ========== UTILS ========== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("Errore:", err?.stack || err?.message || err);
  process.exit(1);
});
