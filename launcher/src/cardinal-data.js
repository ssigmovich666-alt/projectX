// Чтение данных Cardinal без его запуска: версия, плагины, логи, проверка папки.
const fs = require('node:fs/promises');
const path = require('node:path');

const exists = file => fs.access(file).then(() => true, () => false);

async function inspectBot(botDir) {
  const [hasMain, hasConfig] = await Promise.all([
    exists(path.join(botDir, 'main.py')), exists(path.join(botDir, 'configs', '_main.cfg'))
  ]);
  let version = null;
  if (hasMain) {
    const source = await fs.readFile(path.join(botDir, 'main.py'), 'utf8');
    version = source.match(/^VERSION\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  }
  return { botDir, hasMain, hasConfig, version };
}

function field(source, name) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
  return match ? (match[1] ?? match[2]) : null;
}

async function disabledPlugins(botDir) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(botDir, 'storage', 'cache', 'disabled_plugins.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function listPlugins(botDir) {
  const folder = path.join(botDir, 'plugins');
  let files;
  try { files = (await fs.readdir(folder)).filter(file => file.endsWith('.py')); }
  catch { return []; }
  const disabled = await disabledPlugins(botDir);
  const plugins = [];
  for (const file of files.sort()) {
    const source = await fs.readFile(path.join(folder, file), 'utf8');
    const first = source.split(/\r?\n/, 1)[0];
    const noplug = first.startsWith('#') && first.split(/\s+/).includes('noplug');
    const uuid = field(source, 'UUID');
    plugins.push({
      file, uuid, noplug,
      name: field(source, 'NAME') || file,
      version: field(source, 'VERSION') || '—',
      description: field(source, 'DESCRIPTION') || '',
      credits: field(source, 'CREDITS') || '',
      enabled: !noplug && !(uuid && disabled.includes(uuid))
    });
  }
  return plugins;
}

// Список отключённых плагинов — тот же файл, что ведёт сам Cardinal (storage/cache/disabled_plugins.json).
async function setPluginEnabled(botDir, uuid, enabled) {
  if (!uuid) throw new Error('У плагина нет UUID.');
  const file = path.join(botDir, 'storage', 'cache', 'disabled_plugins.json');
  const list = new Set(await disabledPlugins(botDir));
  if (enabled) list.delete(uuid); else list.add(uuid);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([...list]), 'utf8');
  return [...list];
}

// Плагины с "# noplug" в первой строке Cardinal не загружает совсем. Включение убирает эту метку, выключение возвращает.
async function setNoplug(botDir, file, noplug) {
  if (!/^[\w.-]+\.py$/.test(file)) throw new Error('Неверное имя файла плагина.');
  const target = path.join(botDir, 'plugins', file);
  const source = await fs.readFile(target, 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const first = lines[0];
  const isMarked = first.startsWith('#') && first.split(/\s+/).includes('noplug');
  if (noplug === isMarked) return;
  if (noplug) lines.unshift('# noplug');
  else {
    const rest = first.slice(1).split(/\s+/).filter(word => word && word !== 'noplug');
    if (rest.length) lines[0] = '# ' + rest.join(' '); else lines.shift();
  }
  await fs.writeFile(target, lines.join(eol), 'utf8');
}

async function togglePlugin(botDir, file, enabled) {
  const plugin = (await listPlugins(botDir)).find(item => item.file === file);
  if (!plugin) throw new Error('Плагин не найден.');
  if (enabled) {
    if (plugin.noplug) await setNoplug(botDir, file, false);
    if (plugin.uuid) await setPluginEnabled(botDir, plugin.uuid, true);
  } else if (plugin.uuid) await setPluginEnabled(botDir, plugin.uuid, false);
  else await setNoplug(botDir, file, true);
  return listPlugins(botDir);
}

const LOG_LINE = /^\[(\d\d\.\d\d\.\d\d \d\d:\d\d:\d\d)\]\[([^\]]*)\]\[(\d+)\]> ([DIWEC]): (.*)$/;

// Читает хвост logs/log.log: последние `bytes` байт, разбирает строки по формату логгера Cardinal.
async function tailLog(botDir, bytes = 256 * 1024) {
  const file = path.join(botDir, 'logs', 'log.log');
  let handle;
  try { handle = await fs.open(file, 'r'); }
  catch { return { file, size: 0, entries: [] }; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let lines = buffer.toString('utf8').split(/\r?\n/);
    if (start > 0) lines = lines.slice(1);
    const entries = [];
    for (const line of lines) {
      if (!line) continue;
      const match = line.match(LOG_LINE);
      if (match) entries.push({ time: match[1], source: `${match[2]}:${match[3]}`, level: match[4], text: match[5].replace(/FunPay\s*Cardinal|Cardinal/gi, 'ProjectX') });
      else if (entries.length) entries[entries.length - 1].text += '\n' + line;
    }
    return { file, size, entries: entries.slice(-1500) };
  } finally { await handle.close(); }
}

module.exports = { inspectBot, listPlugins, setPluginEnabled, togglePlugin, setNoplug, tailLog };
