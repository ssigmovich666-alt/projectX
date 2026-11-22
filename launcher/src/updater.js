'use strict';
// Автообновление ProjectX через GitHub Releases.
//
// Идея: exe остаётся маленьким и стабильным, а всё меняющееся (папка src лаунчера и
// ядро FunPayCardinal-main) приходит с GitHub. boot.js уже умеет подхватывать внешнюю
// папку src рядом с exe, если её версия >= вшитой. Здесь мы эту внешнюю папку скачиваем.
//
// На старте:
//   1) ensureCore()   — если рядом нет ядра (main.py), качаем и распаковываем его (первый запуск).
//   2) checkLauncher() — если на GitHub версия лаунчера новее запущенной, качаем новый src/
//                        и package.json рядом с exe; затем watchUpdates() в main.js увидит
//                        новую версию и предложит перезапуск.
//
// Репозиторий и канал задаются в update-config.json рядом с package.json — так адрес
// обновлений можно поменять, не трогая (обфусцированный) код.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const versionParts = text => String(text || '0').split('.').map(n => parseInt(n, 10) || 0);
const isNewer = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// --- конфигурация ---
function readConfig(appRoot) {
  // appRoot — папка рядом с exe (где лежит package.json). Там же ждём update-config.json.
  const defaults = { owner: '', repo: '', manifest: '', enabled: true, coreDirName: 'FunPayCardinal-main' };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appRoot, 'update-config.json'), 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    // запасной вариант — значения, вшитые при сборке
    try { return { ...defaults, ...require('./update-config.json') }; } catch { return defaults; }
  }
}
function manifestUrl(cfg) {
  if (cfg.manifest) return cfg.manifest;
  if (cfg.owner && cfg.repo) return `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest/download/latest.json`;
  return '';
}

// --- сеть ---
async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ProjectX-Updater', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return res.json();
}
async function download(url, destFile) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ProjectX-Updater' } });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destFile, buf);
  return destFile;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

// --- распаковка zip (Windows 10+: встроенный tar; запасной — PowerShell Expand-Archive) ---
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.slice(0, 300)}`)));
  });
}
async function unzip(zipFile, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await run('tar', ['-xf', zipFile, '-C', destDir]);
  } catch {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Force -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`]);
  }
}

// Если архив распаковался в единственную вложенную папку — вернуть её, иначе сам destDir.
async function flatten(destDir) {
  const entries = await fsp.readdir(destDir, { withFileTypes: true });
  const real = entries.filter(e => e.name !== '__MACOSX');
  if (real.length === 1 && real[0].isDirectory()) return path.join(destDir, real[0].name);
  return destDir;
}

// Переместить содержимое srcDir в targetDir (перезаписывая файлы).
async function mergeInto(srcDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  for (const entry of await fsp.readdir(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) await mergeInto(from, to);
    else { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(from, to); }
  }
}

async function withTempDir(prefix, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); }
  finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function getAndExtract(asset, log, label) {
  if (!asset || !asset.url) throw new Error(`${label}: нет ссылки в манифесте`);
  return withTempDir(`px-${label}-`, async tmp => {
    const zip = path.join(tmp, 'pkg.zip');
    log(`${label}: скачиваю…`);
    await download(asset.url, zip);
    if (asset.sha256) {
      const got = await sha256(zip);
      if (got.toLowerCase() !== String(asset.sha256).toLowerCase()) throw new Error(`${label}: контрольная сумма не совпала`);
    }
    log(`${label}: распаковываю…`);
    const out = path.join(tmp, 'out');
    await unzip(zip, out);
    const root = await flatten(out);
    // Переносим в постоянную temp-папку, чтобы вызвать merge уже после удаления tmp — поэтому merge здесь.
    return root;
  });
}

// --- первый запуск: ядро рядом с exe ---
async function ensureCore({ appRoot, botDir, cfg, log }) {
  if (botDir && fs.existsSync(path.join(botDir, 'main.py'))) return { installed: false };
  const url = manifestUrl(cfg);
  if (!url) { log('Ядро не найдено, но адрес обновлений не настроен.'); return { installed: false, error: 'no-config' }; }
  const manifest = await fetchJson(url);
  if (!manifest.core) throw new Error('В манифесте нет раздела core');
  const target = path.join(appRoot, cfg.coreDirName || 'FunPayCardinal-main');
  await withTempDir('px-core-', async tmp => {
    const zip = path.join(tmp, 'core.zip');
    log('Ядро: скачиваю…');
    await download(manifest.core.url, zip);
    if (manifest.core.sha256) {
      const got = await sha256(zip);
      if (got.toLowerCase() !== String(manifest.core.sha256).toLowerCase()) throw new Error('Ядро: контрольная сумма не совпала');
    }
    log('Ядро: распаковываю…');
    const out = path.join(tmp, 'out');
    await unzip(zip, out);
    await mergeInto(await flatten(out), target);
  });
  log('Ядро установлено.');
  return { installed: true, version: manifest.core.version, dir: target };
}

// --- проверка обновления лаунчера ---
async function checkLauncher({ appRoot, currentVersion, cfg, log }) {
  const url = manifestUrl(cfg);
  if (!url) return { updated: false, error: 'no-config' };
  const manifest = await fetchJson(url);
  if (!manifest.launcher) return { updated: false };
  if (!isNewer(manifest.launcher.version, currentVersion)) return { updated: false, latest: manifest.launcher.version };
  await withTempDir('px-launcher-', async tmp => {
    const zip = path.join(tmp, 'launcher.zip');
    log(`Обновление ${manifest.launcher.version}: скачиваю…`);
    await download(manifest.launcher.url, zip);
    if (manifest.launcher.sha256) {
      const got = await sha256(zip);
      if (got.toLowerCase() !== String(manifest.launcher.sha256).toLowerCase()) throw new Error('Лаунчер: контрольная сумма не совпала');
    }
    log(`Обновление ${manifest.launcher.version}: распаковываю…`);
    const out = path.join(tmp, 'out');
    await unzip(zip, out);
    // Архив лаунчера содержит src/, package.json, assets/, extension/ — кладём рядом с exe.
    await mergeInto(await flatten(out), appRoot);
  });
  log(`Обновление ${manifest.launcher.version} готово. Будет применено после перезапуска.`);
  return { updated: true, version: manifest.launcher.version };
}

// Главная точка: вызывается из main.js на старте. Ничего не роняет — только логирует.
async function runStartupUpdate({ appRoot, botDir, currentVersion, log }) {
  const say = typeof log === 'function' ? log : () => {};
  const cfg = readConfig(appRoot);
  if (cfg.enabled === false) return;
  if (!manifestUrl(cfg)) { say('Автообновление: репозиторий не настроен в update-config.json.'); return; }
  try { await ensureCore({ appRoot, botDir, cfg, log: say }); }
  catch (e) { say('Не удалось установить ядро: ' + (e.message || e)); }
  try { await checkLauncher({ appRoot, currentVersion, cfg, log: say }); }
  catch (e) { say('Проверка обновлений не удалась: ' + (e.message || e)); }
}

module.exports = { runStartupUpdate, ensureCore, checkLauncher, readConfig, manifestUrl, isNewer };
