'use strict';
// Перевод сообщений покупателей на русский через Google Переводчик (translate.googleapis.com, без ключа).
// Отправляется только текст сообщений, в которых нет кириллицы. Результаты кэшируются в памяти.
const CYRILLIC = /[а-яё]/i;
const LETTERS = /\p{L}{2,}/u;

const needsTranslation = text => {
  const value = String(text || '').trim();
  return value.length >= 2 && value.length <= 2000 && LETTERS.test(value) && !CYRILLIC.test(value);
};

class Translator {
  constructor({ fetch, target = 'ru' }) {
    this.fetch = fetch; this.target = target;
    this.cache = new Map(); this.pausedUntil = 0;
  }

  async one(text) {
    if (this.cache.has(text)) return this.cache.get(text);
    if (Date.now() < this.pausedUntil) return null;
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + this.target + '&q=' + encodeURIComponent(text);
    const response = await this.fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (response.status === 429) { this.pausedUntil = Date.now() + 60000; return null; }
    if (!response.ok) throw new Error('Переводчик ответил ' + response.status);
    const data = await response.json();
    const translated = (data?.[0] || []).map(part => part?.[0] || '').join('').trim();
    const from = String(data?.[2] || '');
    const result = translated && from !== this.target && translated.toLowerCase() !== text.trim().toLowerCase() ? { text: translated, from } : { text: '', from };
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(text, result);
    return result;
  }

  async many(texts) {
    if (!Array.isArray(texts)) return [];
    const out = [];
    for (const text of texts.slice(0, 20)) {
      if (!needsTranslation(text)) { out.push(null); continue; }
      try { out.push(await this.one(String(text).trim())); } catch { out.push(null); }
    }
    return out;
  }
}

module.exports = { Translator, needsTranslation };
