'use strict';
// Упаковка релиза ProjectX. Запускается ПОСЛЕ obfuscate + build.
// Делает:
//   release-out/ProjectX-FunPay.exe        — лёгкий лаунчер (из launcher/dist)
//   release-out/launcher-src-<ver>.zip      — обновление лаунчера (src+assets+extension+package.json+update-config.json)
//   release-out/core-<coreVer>.zip          — ядро FunPayCardinal-main (для первого запуска/обновления)
//   release-out/latest.json                 — манифест версий с ссылками и sha256
//
// Ссылки в манифесте указывают на ассеты релиза:
//   https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
// owner/repo/tag берутся из env (GITHUB_REPOSITORY, GITHUB_REF_NAME) или аргументов --repo/--tag.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const launcherDir = path.join(repoRoot, 'launcher');
const coreDir = path.join(repoRoot, 'core');
const outDir = path.join(repoRoot, 'build', 'release-out');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; };

function repoSlug() {
  const a = arg('--repo');
  if (a && a.includes('/')) return a;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes('/')) return process.env.GITHUB_REPOSITORY;
  return '';
}
function tagName(version) {
  return arg('--tag') || process.env.GITHUB_REF_NAME || `v${version}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Кроссплатформенный zip: Windows — Compress-Archive, иначе — zip.
function zipDirContents(items, cwd, zipPath) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  if (process.platform === 'win32') {
    const paths = items.map(i => `'${path.join(cwd, i).replace(/'/g, "''")}'`).join(',');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Force -Path ${paths} -DestinationPath '${zipPath.replace(/'/g, "''")}'`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Compress-Archive не удался');
  } else {
    const r = spawnSync('zip', ['-r', '-q', zipPath, ...items], { cwd, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('zip не удался');
  }
}

async function main() {
  const pkg = JSON.parse(await fsp.readFile(path.join(launcherDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  let coreVersion = version;
  try { coreVersion = (await fsp.readFile(path.join(coreDir, 'VERSION'), 'utf8')).trim() || version; } catch { /* нет VERSION */ }

  const slug = repoSlug();
  const tag = tagName(version);
  const baseUrl = slug ? `https://github.com/${slug}/releases/download/${tag}` : '';

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  // 1) exe
  const exeSrc = path.join(launcherDir, 'dist', 'ProjectX-FunPay.exe');
  const exeOut = path.join(outDir, 'ProjectX-FunPay.exe');
  if (fs.existsSync(exeSrc)) await fsp.copyFile(exeSrc, exeOut);
  else console.warn('ВНИМАНИЕ: не найден', exeSrc, '— пропускаю exe (сначала npm run build).');

  // 2) launcher-src zip (то, что boot.js подхватывает рядом с exe)
  const launcherZip = path.join(outDir, `launcher-src-${version}.zip`);
  const launcherItems = ['src', 'assets', 'extension', 'package.json', 'update-config.json']
    .filter(i => fs.existsSync(path.join(launcherDir, i)));
  zipDirContents(launcherItems, launcherDir, launcherZip);

  // 3) core zip (архив содержит одну верхнюю папку FunPayCardinal-main)
  const coreZip = path.join(outDir, `core-${coreVersion}.zip`);
  zipDirContents([path.basename(coreDir)], repoRoot, coreZip);

  // 4) манифест
  const manifest = {
    launcher: {
      version,
      url: baseUrl ? `${baseUrl}/${path.basename(launcherZip)}` : path.basename(launcherZip),
      sha256: sha256(launcherZip)
    },
    core: {
      version: coreVersion,
      url: baseUrl ? `${baseUrl}/${path.basename(coreZip)}` : path.basename(coreZip),
      sha256: sha256(coreZip)
    },
    published: new Date().toISOString()
  };
  if (fs.existsSync(exeOut)) manifest.exe = { url: baseUrl ? `${baseUrl}/ProjectX-FunPay.exe` : 'ProjectX-FunPay.exe', sha256: sha256(exeOut) };
  await fsp.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('Готово. Ассеты в', outDir);
  for (const f of await fsp.readdir(outDir)) {
    const s = await fsp.stat(path.join(outDir, f));
    console.log(`  ${f}  (${(s.size / 1048576).toFixed(1)} МБ)`);
  }
  if (!slug) console.warn('\nРепозиторий не определён — ссылки в latest.json относительные. Задайте GITHUB_REPOSITORY или --repo owner/repo.');
}

main().catch(e => { console.error(e); process.exit(1); });
