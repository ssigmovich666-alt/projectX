// Настройки плагинов, открываемые по ПКМ на странице «Плагины». Значения пишутся прямо в TOML-конфиг плагина
// (configs/<name>.toml): меняется только строка ключа, комментарии и остальные строки остаются как были.
const fs = require('node:fs/promises');
const path = require('node:path');

const { readMainConfig, setValue } = require('./main-cfg');

const NOMINALS = [15, 25, 50, 100];
const SCHEMAS = {
  '2c62921b-dd65-43d9-947a-ee85702bf4ca': {
    config: '_main.cfg', section: 'BuyerReminders',
    note: 'Каждый вид напоминания включается отдельно. Настройки применяются во время работы бота.',
    fields: [
      { key: 'confirmEnabled', name: 'Напоминать о подтверждении', type: 'toggle', default: false },
      { key: 'confirmCount', name: 'Сколько раз напоминать о подтверждении', type: 'number', min: 1, max: 3, default: 3 },
      { key: 'reviewEnabled', name: 'Напоминать об отзыве', type: 'toggle', default: false },
      { key: 'reviewCount', name: 'Сколько раз напоминать об отзыве', type: 'number', min: 1, max: 3, default: 3 }
    ]
  },
  '384dea70-f7ac-4c25-b4cb-3218d79390ee': {
    config: 'ai_assistant.toml', note: 'Сообщения покупателей отправляются в OpenAI. Для вызова продавца через #help или по решению ИИ включите критические уведомления в своём Telegram-чате с ботом.',
    fields: [
      { key: 'api_key', name: 'API-ключ OpenAI', type: 'password', default: '' },
      { key: 'instruction', name: 'Инструкция для ответов', type: 'textarea', default: '', defaultFile: 'ai_assistant_instruction.txt' }
    ]
  },
  '2eb7cf47-ce48-4734-aa61-b74d7328454e': {
    config: 'multi_delivery.toml', note: 'Поместите файлы в storage/products. Один товар на строку. Выдаётся оплаченное количество.',
    fields: [{ key: 'bindings', name: 'Привязки лотов', type: 'textarea', default: '', hint: 'Каждая строка: ID лота = имя файла.txt' }]
  },
  // plugins/telegram_gift.py
  'a1f6a734-ec4a-45c3-b43c-e70227a33d34': {
    config: 'telegram_gift.toml',
    note: 'Отзывы и авто-активация применяются на лету. Номиналы, ID лотов и «Выдача включена» — после перезапуска бота.',
    fields: [
      { key: 'enabled', name: 'Выдача включена', type: 'toggle', default: false, restart: true,
        hint: 'Главный выключатель выдачи. Нужна авторизация Telegram (--login).' },
      { key: 'auto_activate', name: 'Авто-активация лотов', type: 'toggle', default: false,
        hint: 'Лот номинала неактивен, а Stars на балансе хватает — плагин включает лот и выдаёт.' },
      { key: 'require_review', name: 'Отзывы', type: 'toggle', default: true,
        hint: 'ВКЛ — без отзыва 5★ подарок не выдаётся. ВЫКЛ — после оплаты уточняет Telegram и сразу выдаёт.' },
      ...NOMINALS.map(n => ({ key: `nominal_${n}`, name: `${n} звёзд`, type: 'toggle', default: n === 15, restart: true })),
      ...NOMINALS.map(n => ({
        key: `lot_id_${n}`, name: `ID лота ${n}⭐`, suffix: '0 — найти по названию', type: 'number', min: 0, default: 0,
        restart: true, legacy: n === 15 ? 'lot_id' : null
      }))
    ]
  }
};

const KEY_LINE = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)("(?:[^"\\]|\\.)*"|.*?)(\s*#.*)?$/;
const TABLE_LINE = /^\s*\[/;

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch {} }
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/);
  return quoted ? (quoted[1] ?? quoted[2]) : undefined;
}

// Ключи верхнего уровня (до первой [таблицы]). Сложные значения (массивы, таблицы) не читаем.
function readTopLevel(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    if (TABLE_LINE.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    const match = line.match(KEY_LINE);
    if (match) result[match[2]] = parseValue(match[4]);
  }
  return result;
}

const formatValue = value => typeof value === "string" ? JSON.stringify(value) : String(value);

function writeTopLevel(source, key, value) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.length ? source.split(/\r?\n/) : [];
  let tableAt = lines.findIndex(line => TABLE_LINE.test(line));
  if (tableAt < 0) tableAt = lines.length;
  for (let i = 0; i < tableAt; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const match = lines[i].match(KEY_LINE);
    if (match && match[2] === key) {
      lines[i] = match[1] + key + match[3] + formatValue(value) + (match[5] || '');
      return lines.join(eol);
    }
  }
  let at = tableAt;
  while (at > 0 && lines[at - 1] === '') at--;
  lines.splice(at, 0, `${key} = ${formatValue(value)}`);
  if (!lines.length || lines[lines.length - 1] !== '') lines.push('');
  return lines.join(eol);
}

function schemaFor(uuid) { return uuid ? SCHEMAS[uuid] || null : null; }
const hasSettings = uuid => Boolean(schemaFor(uuid)?.fields?.length);
const configFile = (botDir, schema) => path.join(botDir, 'configs', schema.config);

async function readSource(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function readPluginSettings(botDir, uuid) {
  const schema = schemaFor(uuid);
  if (!schema) throw new Error('У плагина нет настроек.');
  const current = schema.section ? await readMainConfig(botDir) : readTopLevel(await readSource(configFile(botDir, schema)));
  const fields = await Promise.all(schema.fields.map(async field => {
    let value = current[schema.section ? `${schema.section}.${field.key}` : field.key];
    if (schema.section && value !== undefined) {
      value = field.type === 'toggle' ? value === '1' : Number(value);
    }
    if (field.defaultFile && !(typeof value === 'string' && value.trim())) {
      value = (await readSource(path.join(botDir, 'plugins', field.defaultFile))).trim();
    }
    if (value === undefined && field.legacy) value = current[field.legacy];
    const valid = field.type === 'toggle' ? typeof value === 'boolean' : field.type !== 'number' ? typeof value === 'string' : Number.isSafeInteger(value) && value >= (field.min ?? 0) && value <= (field.max ?? Infinity);
    return { ...field, value: valid ? value : field.default };
  }));
  return { config: schema.config, note: schema.note, fields };
}

async function setPluginSetting(botDir, uuid, key, value) {
  const schema = schemaFor(uuid);
  if (!schema) throw new Error('У плагина нет настроек.');
  const field = schema.fields.find(item => item.key === key);
  if (!field) throw new Error('Неизвестная настройка плагина.');
  let next;
  if (field.type === 'toggle') {
    if (typeof value !== 'boolean') throw new Error('Ожидается вкл/выкл.');
    next = value;
  } else if (field.type !== 'number') {
    if (typeof value !== 'string') throw new Error('Ожидается текст.');
    if (key === 'bindings') {
      const ids = new Set();
      for (const line of value.split(/\r?\n/).filter(line => line.trim())) {
        const match = line.match(/^\s*([1-9]\d*)\s*=\s*([^<>:"/\\|?*\x00-\x1f]+?)\s*$/);
        if (!match || /^\.+$/.test(match[2]) || ids.has(match[1])) throw new Error('Укажите уникальный ID лота и имя файла.');
        ids.add(match[1]);
        const stock = path.join(botDir, 'storage', 'products', match[2]);
        if (!(await fs.stat(stock).catch(() => null))?.isFile()) throw new Error('Файл отсутствует в storage/products: ' + match[2]);
      }
    }
    next = value;
  } else {
    next = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (field.max !== undefined && next > field.max) throw new Error(`${field.name}: максимум ${field.max}.`);
    if (!Number.isSafeInteger(next) || next < (field.min ?? 0)) throw new Error(`${field.name}: нужно целое число ≥ ${field.min ?? 0}.`);
  }
  if (schema.section) {
    await setValue(botDir, schema.section, key, typeof next === 'boolean' ? Number(next).toString() : String(next), { createSection: true });
    return readPluginSettings(botDir, uuid);
  }
  const file = configFile(botDir, schema);
  const source = await readSource(file);
  const updated = writeTopLevel(source, key, next);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, updated, 'utf8');
  await fs.rename(temp, file);
  return readPluginSettings(botDir, uuid);
}

module.exports = { hasSettings, readPluginSettings, setPluginSetting, readTopLevel, writeTopLevel, SCHEMAS };
