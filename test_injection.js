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
const CSV_UNITS = (process.env.CSV_UNITS || "ms2").toLowerCase(); // acc: ms2 | g
const CSV_GYRO_UNITS = (process.env.CSV_GYRO_UNITS || "rad_s").toLowerCase(); // rad_s | dps
const CSV_MAG_UNITS  = (process.env.CSV_MAG_UNITS  || "uT").toLowerCase();    // uT | t | mgauss
const CSV_HAS_HEADER = envBool("CSV_HAS_HEADER", true);
const TIMES_ARE_MS = envBool("CSV_TIMES_ARE_MS", true); // false => ns

const INJECTION_MODE = (process.env.INJECTION_MODE || "resample_hz").toLowerCase(); // resample_hz | stream
const TARGET_HZ = Number(process.env.TARGET_HZ || 125);

const INJECT_GYRO = envBool("INJECT_GYRO", false);
const INJECT_MAG  = envBool("INJECT_MAG",  false);

const PRE_ROLL_MS  = Number(process.env.PRE_ROLL_MS || 0);
const LOOP_REPEATS = Number(process.env.LOOP_REPEATS || 1);
const LOOP_GAP_MS  = Number(process.env.LOOP_GAP_MS || 0);

const MIN_SPACING_MS = Number(process.env.MIN_SPACING_MS || 5);
const CAP_DELTA_OVER_60S_TO = Number(process.env.CAP_DELTA_OVER_60S_TO || 50);
const LOG_EVERY_N = Number(process.env.LOG_EVERY_N || 100);

const G = 9.80665;

// APK paths (sovrascrivibili da .env)
const myApplicationPath = process.env.APP_MYAPP_APK      || "C:/Users/Utente/AndroidStudioProjects/MyApplication/app/build/outputs/apk/debug/app-debug.apk";
const runtasticPath     = process.env.APP_RUN_APK        || "C:/Users/Utente/Downloads/Runtastic Pedometer PRO_1.6.2_apkcombo.com.apk";
const tayutauPath       = process.env.APP_TAYUTAU_APK    || "C:/Users/Utente/Downloads/pedometer-5-47.apk";
const accupedoPath      = process.env.APP_ACCUPEDO_APK   || "C:/Users/Utente/Downloads/accupedo-pedometer-9-1-5-1.apk";
const walkloggerPath    = process.env.APP_WALKLOGGER_APK || "C:/Users/Utente/Downloads/walklogger-pedometer.apk";
const forlaniPath       = process.env.APP_FORLANI_APK    || "C:/Users/frafo/OneDrive/Desktop/TESI LAM/release/steplab-v1.0.apk";

/* ========== HELPERS ========== */

function envBool(name, def) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|y|on)$/i.test(v);
}
function isAbsolute(p) {
  return /^([A-Za-z]:\\|\/)/.test(p);
}
function mapAxes([x, y, z]) {
  const pick = (c) => (c === "X" ? x : c === "Y" ? y : z);
  const sx = AXIS_SIGN[0] === "-" ? -1 : 1;
  const sy = AXIS_SIGN[1] === "-" ? -1 : 1;
  const sz = AXIS_SIGN[2] === "-" ? -1 : 1;
  return [sx * pick(AXIS_MAP[0]), sy * pick(AXIS_MAP[1]), sz * pick(AXIS_MAP[2])];
}
function scaleAccel([x, y, z]) {
  const s = (CSV_UNITS === "g") ? G : 1;    // -> m/s^2
  return [x * s, y * s, z * s];
}
function scaleGyro([x, y, z]) {
  const s = (CSV_GYRO_UNITS === "dps") ? (Math.PI / 180) : 1; // -> rad/s
  return [x * s, y * s, z * s];
}
function scaleMag([x, y, z]) {
  let s = 1; // -> µT
  if (CSV_MAG_UNITS === "t") s = 1e6;
  else if (CSV_MAG_UNITS === "mgauss") s = 0.1; // 1 mG = 0.1 µT
  return [x * s, y * s, z * s];
}

function detectCSVFormat(row) {
  if (!row || row.length < 4) return "acc_timestamp";
  const firstIsNumeric = isFiniteNum(row[0]);
  if (row.length >= 10) return firstIsNumeric ? "timestamp_acc_gyro_mag" : "acc_gyro_mag_timestamp";
  if (row.length >= 7)  return firstIsNumeric ? "timestamp_acc_gyro" : "acc_gyro_timestamp";
  return firstIsNumeric ? "timestamp_acc" : "acc_timestamp";
}
function isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n);
}
function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function getTimestamp(row, format) {
  switch (format) {
    case "timestamp_acc":
    case "timestamp_acc_gyro":
    case "timestamp_acc_gyro_mag":
      return Number(row[0]);
    case "acc_timestamp":
    case "acc_gyro_timestamp":
    case "acc_gyro_mag_timestamp":
    default:
      return Number(row[3]);
  }
}
function parseVectors(row, format) {
  if (!row) return { acc: [0,0,0], gyr: [0,0,0], mag: [0,0,0] };
  let ax=0, ay=0, az=0, gx=0, gy=0, gz=0, mx=0, my=0, mz=0;
  switch (format) {
    case "timestamp_acc":
      ax = numOrZero(row[1]); ay = numOrZero(row[2]); az = numOrZero(row[3]); break;
    case "acc_timestamp":
      ax = numOrZero(row[0]); ay = numOrZero(row[1]); az = numOrZero(row[2]); break;
    case "timestamp_acc_gyro":
      ax = numOrZero(row[1]); ay = numOrZero(row[2]); az = numOrZero(row[3]);
      gx = numOrZero(row[4]); gy = numOrZero(row[5]); gz = numOrZero(row[6]); break;
    case "acc_gyro_timestamp":
      ax = numOrZero(row[0]); ay = numOrZero(row[1]); az = numOrZero(row[2]);
      gx = numOrZero(row[4]); gy = numOrZero(row[5]); gz = numOrZero(row[6]); break;
    case "timestamp_acc_gyro_mag":
      ax = numOrZero(row[1]); ay = numOrZero(row[2]); az = numOrZero(row[3]);
      gx = numOrZero(row[4]); gy = numOrZero(row[5]); gz = numOrZero(row[6]);
      mx = numOrZero(row[7]); my = numOrZero(row[8]); mz = numOrZero(row[9]); break;
    case "acc_gyro_mag_timestamp":
      ax = numOrZero(row[0]); ay = numOrZero(row[1]); az = numOrZero(row[2]);
      gx = numOrZero(row[4]); gy = numOrZero(row[5]); gz = numOrZero(row[6]);
      mx = numOrZero(row[7]); my = numOrZero(row[8]); mz = numOrZero(row[9]); break;
  }
  const acc = mapAxes(scaleAccel([ax, ay, az]));
  const gyr = mapAxes(scaleGyro([gx, gy, gz]));
  const mag = mapAxes(scaleMag([mx, my, mz]));
  return { acc, gyr, mag };
}
function computeDeltaMs(prevRow, currRow, format) {
  if (!prevRow) return 0;
  const tPrev = getTimestamp(prevRow, format);
  const tCurr = getTimestamp(currRow, format);
  if (!Number.isFinite(tPrev) || !Number.isFinite(tCurr)) return MIN_SPACING_MS;
  let dt = tCurr - tPrev;
  if (!TIMES_ARE_MS) dt = dt / 1e6;       // ns -> ms
  if (dt < MIN_SPACING_MS) return MIN_SPACING_MS;
  if (dt > 60000) return CAP_DELTA_OVER_60S_TO; // evita pause lunghissime
  return dt;
}

/* ========== UI SIMULATIONS (safe no-ops se non trovano gli elementi) ========== */

async function SimulateRUN(driver) {
  await driver.pause(600);
  try { await driver.$(`android=new UiSelector().text("REMIND ME LATER").className("android.widget.Button")`).click(); } catch {}
  await driver.pause(300);
  try { await driver.$(`android=new UiSelector().text("SKIP")`).click(); } catch {}
  await driver.pause(300);
  try { await driver.$(`android=new UiSelector().textContains("START WORKOUT")`).click(); } catch {}
}
async function SimulateTayutau(driver) {
  try { await driver.$(`android=new UiSelector().textMatches("(?i)start")`).click(); } catch {}
}
async function SimulateForlani(driver) {
  try { await driver.$(`android=new UiSelector().text("ENTER CONFIGURATION")`).click(); } catch {}
  try {
    const scrollSel = `android=new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("Butterworth Filter")`;
    await driver.$(scrollSel);
  } catch {}
  try { await driver.$(`android=new UiSelector().textContains("Butterworth Filter")`).click(); } catch {}
  try { await driver.$(`android=new UiSelector().textContains("START PEDOMETER")`).click(); } catch {}
}
async function SimulateAccupedo()  { /* nessuna azione necessaria */ }
async function SimulateWalklogger(){ /* nessuna azione necessaria */ }

/* ========== CHECK EMULATORE (senza adb_shell) ========== */
// Non usiamo mobile:shell. Proviamo un comando innocuo alla console emulatore.
async function ensureEmulator(driver) {
  try {
    await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: 'help' }]);
    // Se non esplode, la console è disponibile (ed è un emulatore con emulator_console abilitato)
  } catch (e) {
    throw new Error(
      "Target non sembra un emulatore OPPURE manca --allow-insecure=emulator_console. " +
      "Avvia Appium con: appium --allow-insecure=emulator_console. Dettagli: " + (e?.message || e)
    );
  }
}

/* ========== CARICAMENTO CSV ========== */

async function loadCsvAllRows(csvPath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(parse({ delimiter: ",", from_line: 1, relax_column_count: true, skip_empty_lines: true }))
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

// restituisce { format, samples: [{tMs, acc:[x,y,z], gyr:[x,y,z], mag:[x,y,z]}] }
function buildSamplesFromRows(rows) {
  if (!rows || rows.length === 0) return { format: "acc_timestamp", samples: [] };

  let startIdx = 0;
  if (CSV_HAS_HEADER) {
    // trova la prima riga “numericamente valida”
    while (startIdx < rows.length) {
      const r = rows[startIdx];
      const maybeHeader = !(isFiniteNum(r[0]) || isFiniteNum(r[3]));
      if (!r || r.length < 4 || maybeHeader) startIdx++;
      else break;
    }
  }
  if (startIdx >= rows.length) return { format: "acc_timestamp", samples: [] };

  const format = detectCSVFormat(rows[startIdx]);
  const samples = [];

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    const maybeHeader = !(isFiniteNum(row[0]) || isFiniteNum(row[3]));
    if (maybeHeader) continue;

    const tRaw = getTimestamp(row, format);
    if (!Number.isFinite(tRaw)) continue;

    let tMs = TIMES_ARE_MS ? tRaw : (tRaw / 1e6);
    const { acc, gyr, mag } = parseVectors(row, format);
    samples.push({ tMs, acc, gyr, mag });
  }
  // garantisci monotonia crescente e rimuovi duplicati “identici”
  samples.sort((a,b) => a.tMs - b.tMs);
  const dedup = [];
  let lastT = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.tMs)) continue;
    if (s.tMs <= lastT) continue;
    dedup.push(s);
    lastT = s.tMs;
  }
  return { format, samples: dedup };
}

/* ========== RESAMPLING LINEARE A TARGET_HZ ========== */

function resampleUniform(samples, targetHz) {
  if (!samples || samples.length === 0) return [];
  const dt = 1000 / targetHz; // ms
  const t0 = samples[0].tMs;
  const tN = samples[samples.length - 1].tMs;
  if (tN <= t0) return [];

  const out = [];
  let k = 0;

  for (let t = t0; t <= tN; t += dt) {
    // avanza k finché samples[k].tMs <= t < samples[k+1].tMs
    while (k < samples.length - 2 && samples[k+1].tMs < t) k++;

    const s0 = samples[k];
    const s1 = samples[Math.min(k + 1, samples.length - 1)];
    const t0s = s0.tMs, t1s = s1.tMs;
    const alpha = t1s > t0s ? (t - t0s) / (t1s - t0s) : 0;

    const lerpVec = (a, b) => [
      a[0] + (b[0] - a[0]) * alpha,
      a[1] + (b[1] - a[1]) * alpha,
      a[2] + (b[2] - a[2]) * alpha,
    ];

    out.push({
      tMs: t,
      acc: lerpVec(s0.acc, s1.acc),
      gyr: lerpVec(s0.gyr, s1.gyr),
      mag: lerpVec(s0.mag, s1.mag),
    });
  }
  return out;
}

/* ========== INIEZIONE ========== */

async function injectSamples(driver, samples) {
  if (!samples || samples.length === 0) return;

  if (PRE_ROLL_MS > 0) await driver.pause(PRE_ROLL_MS);

  for (let loop = 0; loop < Math.max(1, LOOP_REPEATS); loop++) {
    let prevT = samples[0].tMs;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const dt = Math.max(MIN_SPACING_MS, Math.min(s.tMs - prevT, 60000));
      if (i > 0) await driver.pause(dt);

      // invio comandi (sempre accelerometro)
      await driver.executeScript('mobile: execEmuConsoleCommand', [{
        command: `sensor set acceleration ${s.acc[0]}:${s.acc[1]}:${s.acc[2]}`
      }]);

      if (INJECT_GYRO && (s.gyr[0] || s.gyr[1] || s.gyr[2])) {
        await driver.executeScript('mobile: execEmuConsoleCommand', [{
          command: `sensor set gyroscope ${s.gyr[0]}:${s.gyr[1]}:${s.gyr[2]}`
        }]);
      }

      if (INJECT_MAG && (s.mag[0] || s.mag[1] || s.mag[2])) {
        await driver.executeScript('mobile: execEmuConsoleCommand', [{
          command: `sensor set magnetic-field ${s.mag[0]}:${s.mag[1]}:${s.mag[2]}`
        }]);
      }

      if (LOG_EVERY_N > 0 && i % LOG_EVERY_N === 0) {
        console.log(`Inject ${i}/${samples.length} @t=${Math.round(s.tMs)}ms`);
      }

      prevT = s.tMs;
    }

    if (loop < LOOP_REPEATS - 1 && LOOP_GAP_MS > 0) {
      await driver.pause(LOOP_GAP_MS);
    }
  }
}

/* ========== STREAMING (alternativa senza resampling) ========== */

async function injectStreaming(driver, csvPath) {
  return new Promise((resolve, reject) => {
    const parser = parse({ delimiter: ",", from_line: 1, relax_column_count: true, skip_empty_lines: true });
    const stream = fs.createReadStream(csvPath).pipe(parser);

    let format = null;
    let prevRow = null;
    let busy = Promise.resolve();

    const pushTask = (fn) => {
      busy = busy.then(fn).catch((e) => {
        if (String(e).includes("terminated") || String(e).includes("not started")) throw e;
        console.warn("Warning in task:", e?.message || e);
      });
    };

    let count = 0;

    parser.on("readable", () => {
      let row;
      while ((row = parser.read()) !== null) {
        // salta header / righe non numeriche
        const isHeader = !(isFiniteNum(row[0]) || isFiniteNum(row[3]));
        if (!row || row.length < 4 || (CSV_HAS_HEADER && isHeader)) continue;

        if (!format) format = detectCSVFormat(row);

        const dt = computeDeltaMs(prevRow, row, format);
        const work = async () => {
          await driver.pause(dt > 0 ? dt : MIN_SPACING_MS);
          const { acc, gyr, mag } = parseVectors(row, format);

          await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: `sensor set acceleration ${acc[0]}:${acc[1]}:${acc[2]}` }]);
          if (INJECT_GYRO && (gyr[0] || gyr[1] || gyr[2])) {
            await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: `sensor set gyroscope ${gyr[0]}:${gyr[1]}:${gyr[2]}` }]);
          }
          if (INJECT_MAG && (mag[0] || mag[1] || mag[2])) {
            await driver.executeScript('mobile: execEmuConsoleCommand', [{ command: `sensor set magnetic-field ${mag[0]}:${mag[1]}:${mag[2]}` }]);
          }

          count++;
          if (LOG_EVERY_N > 0 && count % LOG_EVERY_N === 0) {
            console.log(`Inject ${count} samples (stream)`);
          }
        };

        pushTask(work);
        prevRow = row;
      }
    });

    parser.on("end", () => { busy.then(resolve).catch(reject); });
    parser.on("error", (err) => reject(err));
  });
}

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
    default:           return async () => {}; // <-- evita "simulate is not a function"
  }
}

/* ========== MAIN ========== */

async function main() {
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
  if (!fs.existsSync(csvPath)) {
    console.error("File CSV non trovato:", csvPath);
    process.exit(3);
  }

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
      // SOLO emulator_console. NIENTE adb_shell.
      "appium:allowInsecure": ["emulator_console"]
    }
  };

  console.log("== Avvio sessione ==");
  console.log("APK:", app);
  console.log("CSV:", csvPath);

  const driver = await wdio.remote(opts);

  try {
    // 1) deve essere un emulatore con emulator_console abilitato
    await ensureEmulator(driver);

    // 2) UI prep (safe)
    await simulate(driver);

    // 3) Injection
    console.log("== Preparazione campioni ==");
    if (INJECTION_MODE === "resample_hz") {
      const rows = await loadCsvAllRows(csvPath);
      const { samples } = buildSamplesFromRows(rows);
      if (!samples.length) throw new Error("CSV vuoto o non valido dopo il parsing.");

      const resampled = resampleUniform(samples, TARGET_HZ);
      if (!resampled.length) throw new Error("Resampling fallito / nessun campione utile.");

      console.log(`Resampling a ${TARGET_HZ} Hz: ${resampled.length} campioni.`);
      console.log("== Inizio iniezione (resample) ==");
      await injectSamples(driver, resampled);
    } else {
      console.log("== Inizio iniezione (stream) ==");
      await injectStreaming(driver, csvPath);
    }

    console.log("== Iniezione completata ==");
  } finally {
    try { await driver.pause(500); await driver.deleteSession(); }
    catch (e) { console.warn("Chiusura sessione:", e?.message || e); }
  }
}

main().catch((err) => {
  console.error("Errore:", err?.message || err);
  process.exit(1);
});
