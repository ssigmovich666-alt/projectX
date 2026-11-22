'use strict';
// Обфускация кода лаунчера ProjectX (твой код, не ядро Cardinal).
// По умолчанию обфусцирует ./src на месте. Можно указать другую папку аргументом.
// Запускается при сборке релиза, чтобы в exe и в обновлениях код был нечитаемым.
//
// Пресет консервативный: переименование локальных имён, массив строк, лёгкое запутывание
// потока — но БЕЗ selfDefending/debugProtection (ломают Electron и усложняют поддержку).
// Preload-файлы и update-config не трогаем: в них важны имена и данные.

const fs = require('node:fs');
const path = require('node:path');
let JavaScriptObfuscator;
try { JavaScriptObfuscator = require('javascript-obfuscator'); }
catch { console.error('Нет пакета javascript-obfuscator. Выполните: npm install'); process.exit(1); }

const target = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));

// Эти файлы не обфусцируем: preload завязан на имена через contextBridge, popup-preload тоже.
const SKIP = new Set(['preload.js', 'popup-preload.js']);

const options = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayWrappersType: 'variable',
  splitStrings: false,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  renameGlobals: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'mangled'
};

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js') && !SKIP.has(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(target);
let done = 0;
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  fs.writeFileSync(file, result);
  done++;
}
console.log(`Обфусцировано файлов: ${done} (пропущены preload: ${[...SKIP].join(', ')})`);
console.log('Папка:', target);
