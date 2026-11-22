'use strict';
// Загрузчик ProjectX. Если рядом с exe лежит папка src с более новой (или такой же) версией программы,
// запускаем её — так обновления приходят маленькими файлами, без пересборки и передачи exe.
// Если внешняя версия не запустилась, работает версия, вшитая в exe.
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const version = text => String(text || '0').split('.').map(n => parseInt(n, 10) || 0);
const newerOrSame = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return true; };

const bundled = require('../package.json').version;
global.projectxVersion = bundled;
global.projectxSource = 'exe';

let external = null;
if (app.isPackaged) {
  const root = path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const entry = path.join(root, 'src', 'main.js');
    if (pkg.name === 'projectx-funpay' && fs.existsSync(entry) && newerOrSame(pkg.version, bundled)) external = { entry, version: pkg.version };
  } catch { /* рядом нет обновления */ }
}

if (external) {
  try {
    global.projectxVersion = external.version;
    global.projectxSource = 'folder';
    require(external.entry);
  } catch (error) {
    console.error('ProjectX: обновление из папки не запустилось, работаю на версии из exe.', error);
    global.projectxVersion = bundled; global.projectxSource = 'exe';
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.dirname(external.entry))) delete require.cache[key];
    require('./main.js');
  }
} else require('./main.js');
