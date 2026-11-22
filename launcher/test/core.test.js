const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotProcess, resolvePython, splitCommand, stripAnsi } = require('../src/bot');
const { inspectBot, listPlugins, setPluginEnabled, tailLog } = require('../src/cardinal-data');
const { preferences } = require('../src/preferences');

function fakeBot({ config = true, script = 'print("LOGO"); print("By someone"); print("[21-11-2026 10:00:00]> \\x1b[32mhello\\x1b[0m"); import time; time.sleep(30)' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpc-'));
  fs.mkdirSync(path.join(dir, 'configs')); fs.mkdirSync(path.join(dir, 'plugins')); fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'main.py'), `VERSION = "0.1.17.15"\n${script}\n`);
  if (config) fs.writeFileSync(path.join(dir, 'configs', '_main.cfg'), '[FunPay]\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'a.py'), 'import x\nNAME = "Плагин A"\nVERSION = "1.0"\nDESCRIPTION = \'Описание\'\nUUID = "aaaa"\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'b.py'), '# noplug\nNAME = "B"\nUUID = "bbbb"\n');
  fs.writeFileSync(path.join(dir, 'logs', 'log.log'),
    '[21.11.26 10:00:00][main.py][100]> I: старт\n[21.11.26 10:00:01][cardinal.py][5]> E: ошибка\nTraceback line\n');
  return dir;
}

test('helpers', () => {
  assert.deepStrictEqual(splitCommand('"C:\\Program Files\\py.exe" -X utf8'), { command: 'C:\\Program Files\\py.exe', args: ['-X', 'utf8'] });
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.strictEqual(preferences({ scale: 999, accent: 'bad' }, { botDir: 'D:\\x' }).scale, 125);
  assert.strictEqual(preferences({}, { botDir: 'D:\\x' }).botDir, 'D:\\x');
});

test('inspect, plugins, toggle, logs', async () => {
  const dir = fakeBot();
  assert.deepStrictEqual(await inspectBot(dir), { botDir: dir, hasMain: true, hasConfig: true, version: '0.1.17.15' });
  let plugins = await listPlugins(dir);
  assert.strictEqual(plugins.length, 2);
  assert.deepStrictEqual(plugins.map(p => [p.name, p.enabled, p.noplug]), [['Плагин A', true, false], ['B', false, true]]);
  assert.strictEqual(plugins[0].description, 'Описание');
  await setPluginEnabled(dir, 'aaaa', false);
  plugins = await listPlugins(dir);
  assert.strictEqual(plugins[0].enabled, false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'storage/cache/disabled_plugins.json'))), ['aaaa']);
  await setPluginEnabled(dir, 'aaaa', true);
  assert.strictEqual((await listPlugins(dir))[0].enabled, true);
  const log = await tailLog(dir);
  assert.strictEqual(log.entries.length, 2);
  assert.strictEqual(log.entries[1].level, 'E');
  assert.match(log.entries[1].text, /Traceback/);
});

test('process start, output, stop, missing config, autorestart', async () => {
  const py = await resolvePython('', os.tmpdir());
  assert.ok(py, 'python found');
  const dir = fakeBot();
  const bot = new BotProcess();
  const lines = [];
  bot.on('line', line => lines.push(line.text));
  bot.start({ python: py.command, botDir: dir });
  assert.ok(bot.running);
  await new Promise(resolve => { const t = setInterval(() => { if (lines.some(l => l.endsWith('hello'))) { clearInterval(t); resolve(); } }, 50); });
  assert.ok(!lines.includes('LOGO') && !lines.includes('By someone'), 'banner hidden');
  await bot.stop();
  assert.ok(!bot.running);
  assert.ok(bot.lastExit.expected);

  assert.throws(() => new BotProcess().start({ python: py.command, botDir: fakeBot({ config: false }) }), /_main\.cfg/);

  const crash = fakeBot({ script: 'raise SystemExit(3)' });
  const b2 = new BotProcess();
  const exits = [];
  b2.on('exit', e => exits.push(e));
  b2.start({ python: py.command, botDir: crash, autorestart: true });
  await new Promise(resolve => b2.once('exit', resolve));
  assert.strictEqual(exits[0].code, 3);
  assert.ok(b2.status().restartPending);
  b2.cancelRestart();
  assert.ok(!b2.status().restartPending);
});
