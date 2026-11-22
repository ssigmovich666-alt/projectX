// Управление процессом FunPay Cardinal: запуск, остановка, автоперезапуск, построчный вывод.
const { spawn, execFile } = require('node:child_process');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const stripAnsi = text => text.replace(ANSI, '');

// Первая строка лога Cardinal: "[21-11-2026 14:31:00]> I: ...". Всё, что main.py печатает до неё
// в stdout (ASCII-логотип, версия, авторы, ссылки), лаунчер не показывает.
// Полный ребрендинг вывода: в консоли лаунчера бот называется ProjectX.
const rebrand = text => text.replace(/FunPay\s*Cardinal|Cardinal/gi, 'ProjectX');
const LOG_START = /^\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\]>/;

function splitCommand(value) {
  const parts = (value.match(/"[^"]*"|\S+/g) || []).map(part => part.replace(/^"|"$/g, ''));
  return { command: parts[0], args: parts.slice(1) };
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: 8000, ...options }, (error, stdout, stderr) => {
      resolve(error ? null : `${stdout}${stderr}`.trim());
    });
  });
}

// Ищет Python: явный путь из настроек, venv в папке бота, затем py -3 и python из PATH.
async function resolvePython(preferred, botDir) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  for (const venv of ['venv', '.venv', 'env']) {
    const exe = process.platform === 'win32'
      ? path.join(botDir, venv, 'Scripts', 'python.exe')
      : path.join(botDir, venv, 'bin', 'python');
    if (fs.existsSync(exe)) candidates.push(`"${exe}"`);
  }
  if (process.platform === 'win32') candidates.push('py -3', 'python');
  else candidates.push('python3', 'python');
  for (const candidate of candidates) {
    const { command, args } = splitCommand(candidate);
    const version = await run(command, [...args, '--version']);
    if (version && /^Python \d/.test(version)) return { command: candidate, version: version.replace('Python ', '') };
  }
  return null;
}

class BotProcess extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.startedAt = null;
    this.stopping = false;
    this.restarts = 0;
    this.lastExit = null;
    this.restartTimer = null;
    this.options = null;
  }

  get running() { return Boolean(this.child); }

  status() {
    return {
      running: this.running, pid: this.child?.pid ?? null, startedAt: this.startedAt,
      restarts: this.restarts, lastExit: this.lastExit, restartPending: Boolean(this.restartTimer)
    };
  }

  emitStatus() { this.emit('status', this.status()); }

  line(text, stream = 'out') {
    for (const raw of text.split(/\r?\n/)) {
      const clean = stripAnsi(raw).replace(/\r/g, '').trimEnd();
      if (!clean) continue;
      if (stream === 'out' && this.banner) {
        if (!LOG_START.test(clean)) continue;
        this.banner = false;
      }
      if (stream === 'err' && /SyntaxWarning: .*invalid escape sequence/.test(clean)) { this.skipNextErr = true; continue; }
      if (stream === 'err' && this.skipNextErr) { this.skipNextErr = false; if (/^\s/.test(raw)) continue; }
      this.emit('line', { text: rebrand(clean), stream, time: Date.now() });
    }
  }

  start(options) {
    if (this.child) throw new Error('Бот уже запущен.');
    clearTimeout(this.restartTimer); this.restartTimer = null;
    this.options = options;
    const { python, botDir } = options;
    if (!fs.existsSync(path.join(botDir, 'main.py'))) throw new Error(`В папке ${botDir} нет main.py.`);
    if (!fs.existsSync(path.join(botDir, 'configs', '_main.cfg'))) {
      throw new Error('Нет configs/_main.cfg. Сначала пройдите первую настройку Cardinal.');
    }
    const { command, args } = splitCommand(python);
    this.stopping = false;
    this.banner = true;
    this.skipNextErr = false;
    const child = spawn(command, [...args, '-u', 'main.py'], {
      cwd: botDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONWARNINGS: 'ignore::SyntaxWarning' }
    });
    this.child = child;
    this.startedAt = Date.now();
    const buffers = { out: '', err: '' };
    const feed = stream => chunk => {
      buffers[stream] += chunk.toString('utf8');
      const cut = buffers[stream].lastIndexOf('\n');
      if (cut >= 0) { this.line(buffers[stream].slice(0, cut), stream); buffers[stream] = buffers[stream].slice(cut + 1); }
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    child.on('error', error => {
      this.line(`Не удалось запустить Python: ${error.message}`, 'sys');
    });
    child.on('close', (code, signal) => {
      if (buffers.out) this.line(buffers.out, 'out');
      if (buffers.err) this.line(buffers.err, 'err');
      const uptime = Date.now() - this.startedAt;
      const expected = this.stopping;
      this.child = null; this.startedAt = null;
      this.lastExit = { code, signal, expected, at: Date.now(), uptime };
      this.line(expected ? 'Бот остановлен.' : `Бот завершился (код ${code ?? signal}).`, 'sys');
      this.emit('exit', this.lastExit);
      if (!expected && this.options?.autorestart) this.scheduleRestart(uptime);
      this.emitStatus();
    });
    this.line('Запуск бота…', 'sys');
    this.emitStatus();
  }

  scheduleRestart(uptime) {
    if (uptime > 120000) this.restarts = 0;
    const delay = Math.min(60000, 5000 * 2 ** Math.min(this.restarts, 4));
    this.restarts += 1;
    this.line(`Автоперезапуск через ${Math.round(delay / 1000)} с.`, 'sys');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      try { this.start(this.options); } catch (error) { this.line(error.message, 'sys'); this.emitStatus(); }
    }, delay);
  }

  cancelRestart() {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer); this.restartTimer = null;
    this.line('Автоперезапуск отменён.', 'sys');
    this.emitStatus();
  }

  stop() {
    this.cancelRestart();
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = true;
    return new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* уже завершён */ } }, 8000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGTERM');
    });
  }

  async restart(options) {
    await this.stop();
    this.restarts = 0;
    this.start(options || this.options);
  }
}

module.exports = { BotProcess, resolvePython, splitCommand, stripAnsi, rebrand };
