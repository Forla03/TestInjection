require("dotenv").config();

const wdio = require("webdriverio");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");

/**
 * Avvio Appium:
 *   appium --allow-insecure "*:emulator_console"
 */

/* -------------------- Utils ENV & Path -------------------- */
function envBool(name, def) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes)$/i.test(v);
}

function normalizeMaybeResolve(p) {
  if (!p) return null;
  const trimmed = p.replace(/[\r\n]/g, "").trim().replace(/^"(.*)"$/, "$1");
  // Normalizzazioni path Windows
  let cleaned = trimmed
    .replace(/\\+\\/g, "\\")
    .replace(/\\+(?=\s)/g, "\\")
    .replace(/\\{3,}/g, "\\\\");
  // Esempio fix: \\\release -> \release
  cleaned = cleaned.replace(/\\+release/i, "\\release");

  if (/^[A-Za-z]:[\\/]/.test(cleaned)) {
    return path.normalize(cleaned);
  }
  return path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(process.cwd(), cleaned);
}

/* -------------------- Config -------------------- */
const APP_ALIASES = ["run", "tayutau", "accupedo", "walklogger", "forlani", "myapp"];

// Modalità di iniezione temporale
// - "fixed_hz": ignora i Δt del CSV e usa TARGET_HZ (durata comprimibile/estendibile)
// - "from_csv": rispetta i Δt del CSV (ms o ns in base a CSV_TIMES_ARE_MS)
// - "resample_hz": upsample/downsample lineare a TARGET_HZ ma CONSERVA la durata complessiva
const MODE = (process.env.INJECTION_MODE || "fixed_hz").toLowerCase();
const TARGET_HZ = Number(process.env.TARGET_HZ || 10);

// Assi e unità
const AXIS_MAP = (process.env.AXIS_MAP || "XYZ").toUpperCase(); // es. "ZXY"
const AXIS_SIGN = (process.env.AXIS_SIGN || "+++");             // es. "-++"
const CSV_UNITS = (process.env.CSV_UNITS || "ms2").toLowerCase(); // "ms2" | "g"
const G = 9.80665;

// Opzioni CSV
const CSV_HAS_HEADER = envBool("CSV_HAS_HEADER", false);
const CSV_TIMES_ARE_MS = envBool("CSV_TIMES_ARE_MS", false);

// Iniezioni opzionali
const INJECT_GYRO = envBool("INJECT_GYRO", false);
const INJECT_MAG  = envBool("INJECT_MAG", false);

// Pre-roll e loop
const PRE_ROLL_MS  = Number(process.env.PRE_ROLL_MS || 0);
const LOOP_REPEATS = Number(process.env.LOOP_REPEATS || 1);
const LOOP_GAP_MS  = Number(process.env.LOOP_GAP_MS || 0);

// Logging
const LOG_EVERY_N = Number(process.env.LOG_EVERY_N || 100);

/* -------------------- Helpers assi -------------------- */
function mapAxes([x, y, z]) {
  const pick = (c) => (c === "X" ? x : c === "Y" ? y : z);
  const sx = AXIS_SIGN[0] === "-" ? -1 : 1;
  const sy = AXIS_SIGN[1] === "-" ? -1 : 1;
  const sz = AXIS_SIGN[2] === "-" ? -1 : 1;
  return [sx * pick(AXIS_MAP[0]), sy * pick(AXIS_MAP[1]), sz * pick(AXIS_MAP[2])];
}

function scaleUnits(a) {
  // a in input può essere in m/s^2 (ms2) o in g
  return CSV_UNITS === "g" ? a * G : a;
}

/* --------- Interpolazione lineare per resample_hz --------- */
function linInterp(x0, y0, x1, y1, x) {
  if (x1 === x0) return y0;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

function resampleSeries(timesMs, series, targetHz) {
  // timesMs: array monotono di ms
  const start = timesMs[0];
  const end = timesMs[timesMs.length - 1];
  const dtTarget = 1000 / Math.max(1, targetHz);
  const targetTimes = [];
  for (let t = start; t <= end; t += dtTarget) targetTimes.push(t);
  // Interpola ogni canale di 'series' (obj con chiavi: ax, ay, az, gx, gy, gz, mx, my, mz)
  const channels = Object.keys(series);
  const out = {};
  for (const ch of channels) out[ch] = new Array(targetTimes.length);

  // cursore sui campioni originali
  let j = 0;
  for (let i = 0; i < targetTimes.length; i++) {
    const t = targetTimes[i];
    while (j < timesMs.length - 2 && timesMs[j + 1] < t) j++;
    const t0 = timesMs[j], t1 = timesMs[j + 1] ?? timesMs[j];
    for (const ch of channels) {
      const v0 = series[ch][j];
      const v1 = series[ch][j + 1] ?? v0;
      out[ch][i] = linInterp(t0, v0, t1, v1, t);
    }
  }
  return { targetTimes, resampled: out, dtTarget: Math.round(dtTarget) };
}

/* -------------------- Main -------------------- */
async function main() {
  const appAlias = (process.argv[2] || "").toLowerCase();
  const csvArg = process.argv[3] || process.env.CSV_FILE || null;
  const scriptName = path.basename(process.argv[1] || "inject_pedometer.js");

  if (!APP_ALIASES.includes(appAlias)) {
    throw new Error(`Unrecognized app alias. Use one of: ${APP_ALIASES.join(" | ")}`);
  }
  if (!csvArg) {
    throw new Error(`CSV not specified. Usage: 'node ${scriptName} <alias> <file.csv>' or define CSV_FILE in .env`);
  }

  const csvPath = normalizeMaybeResolve(csvArg);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  // Read config for the alias
  const upper = appAlias.toUpperCase();
  const apk = normalizeMaybeResolve(process.env[`APP_${upper}_APK`]);
  const appPackage = process.env[`APP_${upper}_PACKAGE`];
  const appActivity = process.env[`APP_${upper}_ACTIVITY`];

  const capabilities = {
    platformName: "Android",
    "appium:deviceName": process.env.DEVICE_NAME || "Android Emulator",
    "appium:automationName": process.env.AUTOMATION_NAME || "UiAutomator2",
    "appium:newCommandTimeout": Number(process.env.NEW_COMMAND_TIMEOUT || 600),
    "appium:autoGrantPermissions": envBool("AUTO_GRANT_PERMISSIONS", true),
    "appium:noReset": envBool("NO_RESET", true),
  };

  if (apk) {
    if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);
    capabilities["appium:app"] = apk;
  } else if (appPackage && appActivity) {
    capabilities["appium:appPackage"] = appPackage;
    capabilities["appium:appActivity"] = appActivity;
  } else {
    throw new Error(
      `Missing configuration for alias "${appAlias}". Define APP_${upper}_APK or APP_${upper}_PACKAGE + APP_${upper}_ACTIVITY in .env`
    );
  }

  const opts = {
    hostname: process.env.APPIUM_HOST || "127.0.0.1",
    port: Number(process.env.APPIUM_PORT || 4723),
    path: process.env.APPIUM_BASE_PATH || "/",
    capabilities,
  };

  const client = await wdio.remote(opts);

  /* --- UI prep per app --- */
  const simulateMap = {
    run: SimulateRUN,
    tayutau: SimulateTayutau,
    accupedo: SimulateAccupedo,
    walklogger: SimulateWalklogger,
    forlani: SimulateForlani,
    myapp: async () => {},
  };
  const simulate = simulateMap[appAlias] || (async () => {});

  // 1) Optional UI preparation
  await simulate(client);

  // 2) Optional pre-roll
  if (PRE_ROLL_MS > 0) await client.pause(PRE_ROLL_MS);

  // 3) Carica CSV (grezzo)
  const rawRows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(parse({ delimiter: ",", from_line: CSV_HAS_HEADER ? 2 : 1 }))
      .on("data", (row) => rawRows.push(row))
      .on("end", resolve)
      .on("error", reject);
  });

  // 3b) Parse layout flessibile -> arrays numerici + tempi ms (monotoni)
  const timesMs = [];
  const axArr = [], ayArr = [], azArr = [];
  const gxArr = [], gyArr = [], gzArr = [];
  const mxArr = [], myArr = [], mzArr = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length < 4) continue;

    // Salta intestazioni
    if (row.some((v) => isNaN(Number(v)) && typeof v === "string" && v.toLowerCase().includes("timestamp"))) {
      continue;
    }

    let timestamp, ax, ay, az, gx, gy, gz, mx, my, mz;
    if (Number(row[0]) > 1e11 && row.length >= 10) {
      timestamp = Number(row[0]);
      ax = Number(row[1]); ay = Number(row[2]); az = Number(row[3]);
      gx = Number(row[4]); gy = Number(row[5]); gz = Number(row[6]);
      mx = Number(row[7]); my = Number(row[8]); mz = Number(row[9]);
    } else if (row.length >= 10) {
      ax = Number(row[0]); ay = Number(row[1]); az = Number(row[2]); timestamp = Number(row[3]);
      gx = Number(row[4]); gy = Number(row[5]); gz = Number(row[6]);
      mx = Number(row[7]); my = Number(row[8]); mz = Number(row[9]);
    } else if (row.length >= 7) {
      if (Number(row[0]) > 1e11) {
        timestamp = Number(row[0]);
        ax = Number(row[1]); ay = Number(row[2]); az = Number(row[3]);
        gx = Number(row[4]); gy = Number(row[5]); gz = Number(row[6]);
        mx = 0; my = 0; mz = 0;
      } else {
        ax = Number(row[0]); ay = Number(row[1]); az = Number(row[2]); timestamp = Number(row[3]);
        gx = Number(row[4]); gy = Number(row[5]); gz = Number(row[6]);
        mx = 0; my = 0; mz = 0;
      }
    } else {
      if (Number(row[0]) > 1e11 && row.length >= 4) {
        timestamp = Number(row[0]);
        ax = Number(row[1]); ay = Number(row[2]); az = Number(row[3]);
      } else {
        ax = Number(row[0]); ay = Number(row[1]); az = Number(row[2]); timestamp = Number(row[3]);
      }
      gx = 0; gy = 0; gz = 0; mx = 0; my = 0; mz = 0;
    }

    if ([ax, ay, az].some((v) => Number.isNaN(v)) || Number.isNaN(timestamp)) continue;

    const tMs = CSV_TIMES_ARE_MS ? timestamp : Math.round(timestamp / 1_000_000);
    if (timesMs.length > 0 && tMs <= timesMs[timesMs.length - 1]) {
      // rimuovi campioni non monotoni
      continue;
    }

    // Scala e mappa assi accelerometro
    let [rax, ray, raz] = mapAxes([scaleUnits(ax), scaleUnits(ay), scaleUnits(az)]);

    timesMs.push(tMs);
    axArr.push(rax); ayArr.push(ray); azArr.push(raz);
    gxArr.push(Number.isFinite(gx) ? gx : 0);
    gyArr.push(Number.isFinite(gy) ? gy : 0);
    gzArr.push(Number.isFinite(gz) ? gz : 0);
    mxArr.push(Number.isFinite(mx) ? mx : 0);
    myArr.push(Number.isFinite(my) ? my : 0);
    mzArr.push(Number.isFinite(mz) ? mz : 0);
  }

  if (timesMs.length < 2) throw new Error("CSV privo di timestamp validi o troppo pochi campioni.");

  const durationMs = timesMs[timesMs.length - 1] - timesMs[0];
  const approxHz = Math.round((timesMs.length / (durationMs / 1000)) * 100) / 100;

  // 4) Prepara la sequenza da iniettare in base alla MODE
  let seq = null; // { times:[], ax:[], ay:[], az:[], gx:[], gy:[], gz:[], mx:[], my:[], mz:[], pauseMs }
  if (MODE === "fixed_hz") {
    seq = {
      times: timesMs, // solo per log
      ax: axArr, ay: ayArr, az: azArr,
      gx: gxArr, gy: gyArr, gz: gzArr,
      mx: mxArr, my: myArr, mz: mzArr,
      pauseMs: Math.max(1, Math.round(1000 / Math.max(1, TARGET_HZ)) ),
      durationTargetMs: Math.round((axArr.length - 1) * (1000 / Math.max(1, TARGET_HZ)))
    };
  } else if (MODE === "from_csv") {
    seq = {
      times: timesMs,
      ax: axArr, ay: ayArr, az: azArr,
      gx: gxArr, gy: gyArr, gz: gzArr,
      mx: mxArr, my: myArr, mz: mzArr,
      // pause calcolata dinamicamente dal Δt successivo
      pauseMs: null,
      durationTargetMs: durationMs
    };
  } else if (MODE === "resample_hz") {
    const { targetTimes, resampled, dtTarget } = resampleSeries(timesMs, {
      ax: axArr, ay: ayArr, az: azArr,
      gx: gxArr, gy: gyArr, gz: gzArr,
      mx: mxArr, my: myArr, mz: mzArr,
    }, TARGET_HZ);

    seq = {
      times: targetTimes,
      ...resampled,
      pauseMs: dtTarget,                 // pausa fissa per mantenere la DURATA
      durationTargetMs: Math.round((targetTimes.length - 1) * dtTarget)
    };
  } else {
    throw new Error(`Unknown INJECTION_MODE: ${MODE}`);
  }

  console.log(`[INFO] CSV: ${timesMs.length} campioni, durata ~${Math.round(durationMs)} ms, Hz≈${approxHz}`);
  console.log(`[INFO] MODE=${MODE}${seq.pauseMs ? `, pause≈${seq.pauseMs}ms` : ""}, targetHz=${TARGET_HZ}`);

  // 5) Loop di iniezione (con metrica effettiva)
  const totalPoints = seq.ax.length;
  let warnedInsecure = false;
  const startWall = Date.now();

  for (let r = 0; r < LOOP_REPEATS; r++) {
    console.log(`[INFO] Injection loop ${r + 1}/${LOOP_REPEATS}...`);
    for (let i = 0; i < totalPoints; i++) {
      const rax = seq.ax[i], ray = seq.ay[i], raz = seq.az[i];
      const gxn = INJECT_GYRO ? (seq.gx[i] || 0) : 0;
      const gyn = INJECT_GYRO ? (seq.gy[i] || 0) : 0;
      const gzn = INJECT_GYRO ? (seq.gz[i] || 0) : 0;
      const mxn = INJECT_MAG  ? (seq.mx[i] || 0) : 0;
      const myn = INJECT_MAG  ? (seq.my[i] || 0) : 0;
      const mzn = INJECT_MAG  ? (seq.mz[i] || 0) : 0;

      const commands = [
        `sensor set acceleration ${rax}:${ray}:${raz}`,
        ...(INJECT_GYRO ? [`sensor set gyroscope ${gxn}:${gyn}:${gzn}`] : []),
        ...(INJECT_MAG  ? [`sensor set magnetic-field ${mxn}:${myn}:${mzn}`] : []),
      ];

      let commandFailed = false;
      for (const cmd of commands) {
        try {
          await client.execute("mobile: execEmuConsoleCommand", { command: cmd });
        } catch (err) {
          const msg = String(err.message || err);
          if (msg.includes("emulator_console") && !warnedInsecure) {
            console.error(
              "Cannot inject sensors: Appium insecure feature 'emulator_console' is disabled. " +
              "Restart Appium with --allow-insecure '*:emulator_console'."
            );
            warnedInsecure = true;
            commandFailed = true;
            break;
          } else {
            console.warn("Failed to send sensor command", cmd, msg);
          }
        }
      }
      if (commandFailed) break;

      if (LOG_EVERY_N > 0 && i > 0 && i % LOG_EVERY_N === 0) {
        console.log(`[INFO] Processed ${i}/${totalPoints} points...`);
      }

      // Timing
      if (MODE === "from_csv") {
        // Δt rispetto al campione successivo
        let dt = 0;
        if (i < seq.times.length - 1) {
          dt = seq.times[i + 1] - seq.times[i];
        }
        await client.pause(dt > 0 ? dt : 20);
      } else {
        await client.pause(seq.pauseMs);
      }
    }
    if (r < LOOP_REPEATS - 1 && LOOP_GAP_MS > 0) await client.pause(LOOP_GAP_MS);
  }

  const endWall = Date.now();
  const wallMs = endWall - startWall;
  const effHz = Math.round(((totalPoints * LOOP_REPEATS) / (wallMs / 1000)) * 100) / 100;
  console.log(`[INFO] Injection done. Wall time ≈ ${wallMs} ms, effective avg rate ≈ ${effHz} Hz.`);

  await client.pause(500);
  await client.deleteSession();

  /* -------------------- UI routines -------------------- */
  async function SimulateRUN(client) {
    await client.pause(1000);
    let selector = 'new UiSelector().text("REMIND ME LATER").className("android.widget.Button")';
    await safeClick(selector);

    await client.pause(1000);
    selector = 'new UiSelector().text("SKIP")';
    await safeClick(selector);

    await client.pause(1000);
    selector = 'new UiSelector().text("START WORKOUT")';
    await safeClick(selector);
  }

  async function SimulateTayutau(client) {
    const selector = 'new UiSelector().text("START")';
    await safeClick(selector);
  }

  async function SimulateForlani(client) {
    let selector = 'new UiSelector().text("ENTER CONFIGURATION")';
    await safeClick(selector);
    const scrollSel = `android=new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("${"10Hz"}")`;
    await client.$(scrollSel).catch(() => {});
    selector = 'new UiSelector().text("No Filter")';
    await safeClick(selector);
    selector = 'new UiSelector().text("START PEDOMETER")';
    await safeClick(selector);
  }

  async function SimulateAccupedo(client) { /* TODO */ }
  async function SimulateWalklogger(client) { /* TODO */ }

  async function safeClick(uiSelector) {
    try {
      const el = await client.$(`android=${uiSelector}`);
      if (await el.isExisting()) await el.click();
    } catch (_) { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
