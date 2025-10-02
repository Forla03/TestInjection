// inject_sensors.js
// Replay CSV su emulatore Android via Appium (UiAutomator2) usando la console sensori.
// Uso: node inject_sensors.js <app> <file.csv>
// <app> ∈ { run, tayutau, accupedo, walklogger, forlani }

require("dotenv").config();
const wdio = require("webdriverio");
const fs = require("fs");
const { parse } = require("csv-parse");
const readline = require("readline");
const path = require("path");
const admin = require("firebase-admin");
const https = require("https");
const { promisify } = require("util");

/* ========== FIREBASE SETUP ========== */

const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "motiontrackertesi.firebasestorage.app"
});

const bucket = admin.storage().bucket();

/* ========== ENV & COSTANTI ========== */

const AXIS_MAP  = (process.env.AXIS_MAP  || "XYZ").toUpperCase(); // p.es. ZXY
const AXIS_SIGN = (process.env.AXIS_SIGN || "+++");

const CSV_UNITS       = (process.env.CSV_UNITS || "ms2").toLowerCase();      // acc: ms2 | g
const CSV_GYRO_UNITS  = (process.env.CSV_GYRO_UNITS || "rad_s").toLowerCase(); // rad_s | dps
const CSV_MAG_UNITS   = (process.env.CSV_MAG_UNITS  || "uT").toLowerCase();    // uT | t | mgauss
const CSV_HAS_HEADER  = envBool("CSV_HAS_HEADER", true);
const TIMES_ARE_MS    = envBool("CSV_TIMES_ARE_MS", true); // false => ns
const CSV_LAYOUT      = (process.env.CSV_LAYOUT || "").trim().toLowerCase();  // es. "t,ax,ay,az,gx,gy,gz,mx,my,mz"
const INJECT_GYRO     = true;
const INJECT_MAG      = true;

const PRE_ROLL_MS     = Number(process.env.PRE_ROLL_MS || 0);
const LOOP_REPEATS    = Number(process.env.LOOP_REPEATS || 1);
const LOOP_GAP_MS     = Number(process.env.LOOP_GAP_MS || 0);
const LOG_EVERY_N     = Number(process.env.LOG_EVERY_N || 100);

const DROP_NON_MONOTONIC = envBool("DROP_NON_MONOTONIC", true);

const G = 9.80665;

// APK paths 
const runtasticPath     = process.env.APP_RUN_APK        || "C:/Users/Utente/Downloads/Runtastic Pedometer PRO_1.6.2_apkcombo.com.apk";
const tayutauPath       = process.env.APP_TAYUTAU_APK    || "C:/Users/Utente/Downloads/pedometer-5-47.apk";
const accupedoPath      = process.env.APP_ACCUPEDO_APK   || "C:/Users/Utente/Downloads/accupedo-pedometer-9-1-5-1.apk";
const walkloggerPath    = process.env.APP_WALKLOGGER_APK || "C:/Users/Utente/Downloads/walklogger-pedometer.apk";
const forlaniPath       = process.env.APP_FORLANI_APK    || "C:/Users/frafo/OneDrive/Desktop/TESI LAM/release/steplab-v1.0.apk";

/* ========== HELPERS ========== */

function envBool(name, def) { const v = process.env[name]; if (v == null) return def; return /^(1|true|yes|y|on)$/i.test(v); }
function isAbsolute(p)      { return /^([A-Za-z]:\\|\/)/.test(p); }

/* ========== FIREBASE STORAGE FUNCTIONS ========== */

async function listDateFolders() {
  try {
    const [files] = await bucket.getFiles({ prefix: 'motion_data/' });
    const folders = new Set();
    
    files.forEach(file => {
      const pathParts = file.name.split('/');
      if (pathParts.length >= 2 && pathParts[0] === 'motion_data' && pathParts[1]) {
        const folderName = pathParts[1];
        if (folderName.match(/^\d{4}-\d{2}-\d{2}$/)) {
          folders.add(folderName);
        }
      }
    });
    
    return Array.from(folders).sort();
  } catch (error) {
    console.error('Errore nel listare le cartelle date:', error);
    return [];
  }
}

async function listCSVFilesInDate(dateFolder) {
  try {
    const [files] = await bucket.getFiles({ prefix: `motion_data/${dateFolder}/` });
    return files
      .filter(file => file.name.endsWith('.csv'))
      .map(file => ({
        name: path.basename(file.name),
        fullPath: file.name,
        file: file
      }));
  } catch (error) {
    console.error(`Errore nel listare CSV per la data ${dateFolder}:`, error);
    return [];
  }
}

async function downloadCSVFile(firebaseFile, localPath) {
  try {
    const destination = path.join(__dirname, 'temp_csv', localPath);
    const destDir = path.dirname(destination);
    
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    await firebaseFile.download({ destination });
    console.log(`Download completato: ${localPath}`);
    return destination;
  } catch (error) {
    console.error(`Errore nel download di ${localPath}:`, error);
    return null;
  }
}

async function selectDateAndDownloadCSVs(appName) {
  const folders = await listDateFolders();
  if (folders.length === 0) {
    console.log("Nessuna cartella data trovata in Firebase Storage.");
    return [];
  }
  
  console.log("\n=== SELEZIONE DATA ===");
  console.log("Cartelle date disponibili:");
  folders.forEach((folder, index) => {
    console.log(`${index + 1}. ${folder}`);
  });
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question("Seleziona il numero della data (o 'all' per tutte): ", async (answer) => {
      rl.close();
      
      let selectedFolders = [];
      if (answer.toLowerCase() === 'all') {
        selectedFolders = folders;
      } else {
        const index = parseInt(answer) - 1;
        if (index >= 0 && index < folders.length) {
          selectedFolders = [folders[index]];
        } else {
          console.log("Selezione non valida.");
          resolve([]);
          return;
        }
      }
      
      // Download CSV da cartelle selezionate e filtra già processati
      let allFiles = [];
      let skippedFiles = [];
      
      for (const dateFolder of selectedFolders) {
        console.log(`\nScaricando CSV da ${dateFolder}...`);
        const csvFiles = await listCSVFilesInDate(dateFolder);
        
        for (const csvFile of csvFiles) {
          // Controlla se già processato prima del download
          if (isFileAlreadyProcessed(appName, csvFile.name)) {
            skippedFiles.push(csvFile.name);
            continue;
          }
          
          const localPath = path.join(dateFolder, csvFile.name);
          const downloadedPath = await downloadCSVFile(csvFile.file, localPath);
          if (downloadedPath) {
            allFiles.push({
              name: csvFile.name,
              path: downloadedPath,
              dateFolder: dateFolder
            });
          }
        }
      }
      
      console.log(`\n=== RIEPILOGO DOWNLOAD ===`);
      console.log(`File da processare: ${allFiles.length}`);
      console.log(`File già processati (saltati): ${skippedFiles.length}`);
      if (skippedFiles.length > 0) {
        console.log("File saltati:", skippedFiles.slice(0, 5).join(", ") + (skippedFiles.length > 5 ? "..." : ""));
      }
      
      resolve(allFiles);
    });
  });
}

/* ========== GESTIONE FILE CSV RISULTATI ========== */

function parseFileNameInfo(fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const parts = baseName.split('_');
  
  if (parts.length < 7) {
    console.warn(`Nome file non nel formato atteso: ${fileName}`);
    return {
      walkingType: 'unknown',
      phonePosition: 'unknown',
      age: 'unknown',
      gender: 'unknown',
      device: 'unknown'
    };
  }
  
  let walkingTypeIdx = -1;
  let positionIdx = -1;
  
  const walkingTypes = [
    'PLAIN_WALKING', 'RUNNING', 'IRREGULAR_STEPS', 
    'BABY_STEPS', 'UPHILL_WALKING', 'DOWNHILL_WALKING'
  ];
  
  for (let i = 2; i < parts.length - 4; i++) {
    const candidate = parts.slice(i).join('_');
    for (const type of walkingTypes) {
      if (candidate.startsWith(type)) {
        walkingTypeIdx = i;
        break;
      }
    }
    if (walkingTypeIdx !== -1) break;
  }
  
  if (walkingTypeIdx === -1) walkingTypeIdx = 2;
  
  const positions = ['HAND', 'SHOULDER', 'POCKET'];
  for (let i = walkingTypeIdx; i < parts.length - 2; i++) {
    if (positions.includes(parts[i])) {
      positionIdx = i;
      break;
    }
  }
  
  let walkingType = 'unknown';
  let phonePosition = 'unknown';
  let age = 'unknown';
  let gender = 'unknown';
  let device = 'unknown';
  
  if (positionIdx !== -1) {
    const walkingParts = parts.slice(walkingTypeIdx, positionIdx);
    walkingType = walkingParts.join('_').toLowerCase().replace(/_/g, ' ');
    phonePosition = parts[positionIdx].toLowerCase();
    
    if (positionIdx + 1 < parts.length) {
      const ageCandidate = parts[positionIdx + 1];
      if (/^\d+$/.test(ageCandidate)) {
        age = ageCandidate;
      }
    }
    
    if (positionIdx + 2 < parts.length) {
      const genderCandidate = parts[positionIdx + 2];
      if (['MALE', 'FEMALE', 'M', 'F'].includes(genderCandidate.toUpperCase())) {
        gender = genderCandidate.toLowerCase();
      }
    }
    
    if (positionIdx + 3 < parts.length) {
      const deviceParts = parts.slice(positionIdx + 3);
      device = deviceParts.join(' ').toLowerCase();
    }
  }
  
  return {
    walkingType,
    phonePosition,
    age,
    gender,
    device
  };
}

function getAppResultsFile(appName) {
  const filename = `results_${appName}.csv`;
  const filepath = path.join(__dirname, filename);
  
  // Se il file non esiste, crealo con nuova intestazione
  if (!fs.existsSync(filepath)) {
    const header = "timestamp,csv_file,walking_type,phone_position,age,gender,device,steps_counted\n";
    fs.writeFileSync(filepath, header, 'utf8');
    console.log(`Creato nuovo file risultati: ${filename}`);
  } else {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n');
    if (lines.length > 0 && (lines[0].includes('csv_path') || lines[0].includes('csv_id') || !lines[0].includes('walking_type'))) {
      const header = "timestamp,csv_file,walking_type,phone_position,age,gender,device,steps_counted\n";
      fs.writeFileSync(filepath, header, 'utf8');
      console.log(`Aggiornata struttura file: ${filename}`);
    }
  }
  
  return filepath;
}

function saveStepsResult(appName, csvFile, csvPath, stepsCount) {
  const resultsFile = getAppResultsFile(appName);
  const timestamp = new Date().toISOString();
  
  // Estrai informazioni dal nome del file
  const fileInfo = parseFileNameInfo(csvFile);
  
  const row = `${timestamp},"${csvFile}","${fileInfo.walkingType}","${fileInfo.phonePosition}","${fileInfo.age}","${fileInfo.gender}","${fileInfo.device}",${stepsCount}\n`;
  fs.appendFileSync(resultsFile, row, 'utf8');
  console.log(`Salvato risultato in ${path.basename(resultsFile)}:`);
  console.log(`  Tipo: ${fileInfo.walkingType} | Posizione: ${fileInfo.phonePosition} | Età: ${fileInfo.age} | Sesso: ${fileInfo.gender}`);
  console.log(`  Dispositivo: ${fileInfo.device} | Passi: ${stepsCount}`);
}

function isFileAlreadyProcessed(appName, csvFileName) {
  const resultsFile = getAppResultsFile(appName);
  
  if (!fs.existsSync(resultsFile)) {
    return false;
  }
  
  const content = fs.readFileSync(resultsFile, 'utf8');
  const lines = content.split('\n');
  
  // Controlla se il nome del file è già presente (colonna csv_file)
  for (let i = 1; i < lines.length; i++) { // Salta header
    if (lines[i].trim()) {
      const columns = lines[i].split(',');
      if (columns.length > 1) {
        const existingFileName = columns[1].replace(/"/g, '').trim();
        if (existingFileName === csvFileName) {
          return true;
        }
      }
    }
  }
  
  return false;
}

function askContinueBatch() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question("Vuoi continuare con l'injection del prossimo file? (y/n): ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
    });
  });
}

/* ========== INPUT DA CONSOLE ========== */

function askForSteps() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    console.log("\n=== REGISTRAZIONE PASSI ===");
    console.log("Inserisci il numero di passi registrati dall'app");
    console.log("Opzioni: [numero] = registra passi, 'r' = ripeti injection, 'n' = non salvare");
    
    rl.question("Inserisci scelta: ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

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

async function SimulateRUN(driver, isFirstTime = true) {
  await sleep(600);
  if (isFirstTime) {
    try { await driver.$(`android=new UiSelector().text("REMIND ME LATER").className("android.widget.Button")`).click(); } catch {}
    await sleep(300);
    try { await driver.$(`android=new UiSelector().text("SKIP")`).click(); } catch {}
    await sleep(300);
  }
  try { await driver.$(`android=new UiSelector().textContains("START WORKOUT")`).click(); } catch {}
}

async function SimulateTayutau(driver, isFirstTime = true) { 
  try { await driver.$(`android=new UiSelector().textMatches("(?i)start")`).click(); } catch {} 
}

async function SimulateForlani(driver, isFirstTime = true) {
  try { await driver.$(`android=new UiSelector().text("ENTER CONFIGURATION")`).click(); } catch {}
  
  try {
    const scrollSel = `android=new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("Low-Pass Filter")`;
    await driver.$(scrollSel);
  } catch {}
  try { await driver.$(`android=new UiSelector().textContains("Low-Pass Filter")`).click(); } catch {}
  
  try {
    const scrollSelPeak = `android=new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("Peak Algorithm")`;
    await driver.$(scrollSelPeak);
  } catch {}
  try { await driver.$(`android=new UiSelector().textContains("Peak Algorithm")`).click(); } catch {}
  
  try { await driver.$(`android=new UiSelector().textContains("START PEDOMETER")`).click(); } catch {}
}

async function SimulateAccupedo(driver, isFirstTime = true)  { /* no-op */ }

async function SimulateWalklogger(driver, isFirstTime = true){ /* no-op */ }

/* ========== SELEZIONE APP & SIMULAZIONE ========== */

function selectApp(arg) {
  switch (arg) {
    case "run":        return runtasticPath;
    case "tayutau":    return tayutauPath;
    case "accupedo":   return accupedoPath;
    case "walklogger": return walkloggerPath;
    case "forlani":    return forlaniPath;
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
    default:           return async () => {}; 
  }
}

/* ========== BATCH PROCESSING ========== */

async function processBatchCSVFiles(driver, appArg, csvFiles) {
  let processedCount = 0;
  const simulate = selectSimulation(appArg);
  let isFirstCall = true;
  
  for (let i = 0; i < csvFiles.length; i++) {
    const csvFile = csvFiles[i];
    console.log(`\n=== FILE ${i + 1}/${csvFiles.length} ===`);
    console.log(`File: ${csvFile.name}`);
    console.log(`Data: ${csvFile.dateFolder}`);
    
    // Preparazione UI per il nuovo file
    console.log("== Preparazione UI app ==");
    await simulate(driver, isFirstCall);
    isFirstCall = false;
    
    // Pausa prima dell'injection
    console.log("== Pausa di 2 secondi prima dell'injection ==");
    await sleep(2000);
    
    // Processa il file
    let shouldRepeat = true;
    while (shouldRepeat) {
      console.log("== Inizio iniezione esatta (stream) ==");
      
      // Esegui l'injection
      for (let loop = 0; loop < Math.max(1, LOOP_REPEATS); loop++) {
        await injectExactFromCsv(driver, csvFile.path);
        if (loop < LOOP_REPEATS - 1 && LOOP_GAP_MS > 0) await sleep(LOOP_GAP_MS);
      }
      console.log("== Iniezione completata ==");

      // Chiedi input per i passi
      const userInput = await askForSteps();
      
      if (userInput === 'r') {
        console.log("Ripetizione injection richiesta...\n");
        console.log("== Preparazione per nuova injection ==");
        await simulate(driver, false); // isFirstTime = false
        await sleep(1000);
        shouldRepeat = true;
      } else if (userInput === 'n') {
        console.log("Non salvando risultati per questo file.");
        shouldRepeat = false;
      } else {
        const stepsCount = parseInt(userInput);
        if (isNaN(stepsCount) || stepsCount < 0) {
          console.log("Numero non valido. Non salvando risultati.");
        } else {
          saveStepsResult(appArg, csvFile.name, csvFile.path, stepsCount);
          processedCount++;
        }
        shouldRepeat = false;
      }
    }
    
    // Chiedi se continuare con il prossimo file (se non è l'ultimo)
    if (i < csvFiles.length - 1) {
      const shouldContinue = await askContinueBatch();
      if (!shouldContinue) {
        console.log("Elaborazione batch interrotta dall'utente.");
        break;
      }
    }
  }
  
  console.log(`\n=== RIEPILOGO BATCH ===`);
  console.log(`File processati: ${processedCount}`);
  console.log(`File totali: ${csvFiles.length}`);
}

/* ========== MAIN ========== */

async function main() {
  assertAxisSettings();

  const appArg = (process.argv[2] || "").toLowerCase();
  const mode = process.argv[3]; // 'firebase' o path del file CSV
  
  if (!appArg) {
    console.log("Uso:");
    console.log("  File locale:  node inject_sensors.js <app> <file.csv>");
    console.log("  Firebase:     node inject_sensors.js <app> firebase");
    console.log("app ∈ { run, tayutau, accupedo, walklogger, forlani }");
    process.exit(2);
  }

  const app = selectApp(appArg);
  const simulate = selectSimulation(appArg);
  
  // Determina modalità di esecuzione
  const isFirebaseMode = mode === 'firebase';
  let csvFiles = [];
  
  if (isFirebaseMode) {
    console.log("=== MODALITÀ FIREBASE ===");
    csvFiles = await selectDateAndDownloadCSVs(appArg);
    if (csvFiles.length === 0) {
      console.log("Nessun file CSV da processare. Uscita...");
      process.exit(1);
    }
  } else {
    // Modalità file locale (compatibilità retroattiva)
    const csvArg = mode;
    if (!csvArg) {
      console.log("Specificare il file CSV o 'firebase'");
      process.exit(2);
    }
    
    const csvPath = isAbsolute(csvArg) ? csvArg : (`./${csvArg}`);
    if (!fs.existsSync(csvPath)) { 
      console.error("File CSV non trovato:", csvPath); 
      process.exit(3); 
    }
    
    // Controllo preventivo per modalità file locale
    if (isFileAlreadyProcessed(appArg, path.basename(csvPath))) {
      console.log("File già processato. Uscita...");
      process.exit(0);
    }
    
    // Converti in formato compatibile con batch processing
    csvFiles = [{
      name: path.basename(csvPath),
      path: csvPath,
      dateFolder: 'local'
    }];
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
      "appium:allowInsecure": ["emulator_console"]
    }
  };

  console.log("== Avvio sessione ==");
  console.log("APK:", app);
  console.log(`Modalità: ${isFirebaseMode ? 'Firebase Storage' : 'File locale'}`);
  console.log(`File da processare: ${csvFiles.length}`);

  const driver = await wdio.remote(opts);

  try {
    await ensureEmulator(driver);

    // Processa tutti i file CSV (batch o singolo)
    await processBatchCSVFiles(driver, appArg, csvFiles);
    
  } finally {
    try { await sleep(500); await driver.deleteSession(); }
    catch (e) { console.warn("Chiusura sessione:", e?.message || e); }
    
    // Pulisci file temporanei se in modalità Firebase
    if (isFirebaseMode && fs.existsSync(path.join(__dirname, 'temp_csv'))) {
      try {
        fs.rmSync(path.join(__dirname, 'temp_csv'), { recursive: true, force: true });
        console.log("File temporanei puliti.");
      } catch (e) {
        console.warn("Errore nella pulizia file temporanei:", e.message);
      }
    }
  }
}

/* ========== UTILS ========== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("Errore:", err?.stack || err?.message || err);
  process.exit(1);
});
