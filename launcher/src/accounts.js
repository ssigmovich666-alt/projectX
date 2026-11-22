'use strict';
// Аккаунты FunPay по golden_key. Ключи хранятся только на этом компьютере, зашифрованными
// средствами Windows (safeStorage / DPAPI), и никогда не уходят в окно лаунчера и в логи.
// Переключение записывает ключ выбранного аккаунта в configs/_main.cfg — бот берёт его при запуске.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_FORMAT = /^[a-z0-9]{32}$/;

class Accounts {
  constructor({ dataDir, crypt, readKey, writeKey, identify }) {
    this.file = path.join(dataDir, 'accounts.json');
    this.crypt = crypt; this.readKey = readKey; this.writeKey = writeKey; this.identify = identify;
    this.data = null;
  }

  async load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { this.data = { accounts: [] }; }
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    return this.data;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(this.data, null, 2));
    await fs.rename(temporary, this.file);
  }

  seal(key) { return this.crypt.encrypt(key); }
  open(account) { return this.crypt.decrypt(account.key); }
  fingerprint(key) { return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16); }

  // Публичный вид: без ключа.
  view(activeKey) {
    const active = activeKey ? this.fingerprint(activeKey) : null;
    return this.data.accounts.map(({ key, ...rest }) => ({ ...rest, active: rest.fingerprint === active }));
  }

  async list() {
    await this.load();
    const current = await this.readKey().catch(() => '');
    // Ключ, который уже стоит в конфиге бота, добавляем в список сам, при первом открытии.
    if (current && !this.data.accounts.some(a => a.fingerprint === this.fingerprint(current))) {
      let info = {};
      try { info = await this.identify(current); } catch { /* нет связи — подпишем позже */ }
      this.data.accounts.unshift(this.record(current, info));
      await this.save();
    }
    return this.view(current);
  }

  record(key, info = {}) {
    return { id: crypto.randomUUID(), fingerprint: this.fingerprint(key), key: this.seal(key), username: info.username || 'Аккаунт', userId: info.id || null, avatar: info.avatar || null, addedAt: Date.now() };
  }

  async add(rawKey) {
    const key = String(rawKey || '').trim();
    if (!KEY_FORMAT.test(key)) throw new Error('golden_key — это 32 символа: латинские буквы и цифры.');
    await this.load();
    if (this.data.accounts.some(a => a.fingerprint === this.fingerprint(key))) throw new Error('Этот аккаунт уже добавлен.');
    const info = await this.identify(key); // заодно проверяем, что ключ рабочий
    if (!info?.username) throw new Error('FunPay не принял этот golden_key.');
    this.data.accounts.push(this.record(key, info));
    await this.save();
    return this.list();
  }

  async switchTo(id) {
    await this.load();
    const account = this.data.accounts.find(a => a.id === id);
    if (!account) throw new Error('Аккаунт не найден.');
    await this.writeKey(this.open(account));
    return this.list();
  }

  async remove(id) {
    await this.load();
    const current = await this.readKey().catch(() => '');
    const account = this.data.accounts.find(a => a.id === id);
    if (!account) return this.list();
    if (current && account.fingerprint === this.fingerprint(current)) throw new Error('Нельзя удалить аккаунт, на котором сейчас работает бот. Сначала переключитесь на другой.');
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    await this.save();
    return this.list();
  }

  async update(key, info) {
    await this.load();
    const account = this.data.accounts.find(a => a.fingerprint === this.fingerprint(key));
    if (!account || !info?.username) return;
    if (account.username === info.username && account.avatar === (info.avatar || null)) return;
    Object.assign(account, { username: info.username, userId: info.id || account.userId, avatar: info.avatar || account.avatar });
    await this.save();
  }
}

module.exports = { Accounts, KEY_FORMAT };
