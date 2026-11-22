// Сессия FunPay для лаунчера: профиль, чаты, отправка сообщений.
// golden_key живёт только в памяти главного процесса и уходит только на funpay.com.
const { parseHome, parseUser, decode, plain } = require('./profile');

const BOT_CHARS = /^[⁡⁤]/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36';
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
const randomTag = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

class RateLimitError extends Error {}

function parseChats(html) {
  const chats = [];
  for (const match of html.matchAll(/<a\b([^>]*class="contact-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)) {
    const [, attrs, body] = match;
    const id = Number(attr(attrs, 'data-id'));
    const message = body.match(/<div class="contact-item-message">([\s\S]*?)<\/div>/);
    if (!id || !message) continue;
    const avatar = body.match(/url\(([^)]+)\)/)?.[1]?.replace(/^['"]|['"]$/g, '') || null;
    chats.push({
      id,
      name: plain(body.match(/<div class="media-user-name">([\s\S]*?)<\/div>/)?.[1] || ''),
      last: plain(message[1]).replace(BOT_CHARS, ''),
      time: plain(body.match(/<div class="contact-item-time">([\s\S]*?)<\/div>/)?.[1] || ''),
      unread: /class="contact-item[^"]*\bunread\b/.test(attrs),
      nodeMsg: Number(attr(attrs, 'data-node-msg')) || 0,
      avatar: avatar ? decode(avatar) : null
    });
  }
  return chats;
}

function parseMessages(list, myId, names = {}) {
  const messages = [];
  for (const item of list || []) {
    const html = item.html || '';
    const author = html.match(/<div class="media-user-name">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (author) names[item.author] = plain(author[1]);
    const alert = html.match(/<div[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/);
    const textBlock = html.match(/<div class="chat-msg-text">([\s\S]*?)<\/div>/);
    const image = html.match(/<a[^>]*class="chat-img-link"[^>]*href="([^"]+)"/);
    const date = html.match(/class="chat-msg-date"[^>]*title="([^"]*)"/)?.[1] || html.match(/class="chat-msg-date"[^>]*>([^<]*)</)?.[1] || '';
    let text = item.author === 0 && alert ? plain(alert[1]) : textBlock ? plain(textBlock[1]) : '';
    const byBot = BOT_CHARS.test(text);
    text = text.replace(BOT_CHARS, '');
    messages.push({
      id: item.id, authorId: item.author, author: item.author === 0 ? 'FunPay' : names[item.author] || null,
      mine: item.author === myId, system: item.author === 0, byBot, text, image: image ? decode(image[1]) : null, date: decode(date)
    });
  }
  return { messages, names };
}

class FunPaySession {
  constructor({ goldenKey, userAgent, fetch }) {
    if (!goldenKey) throw new Error('В configs/_main.cfg нет golden_key.');
    this.goldenKey = goldenKey;
    this.userAgent = userAgent || UA;
    this.fetch = fetch;
    this.phpsessid = null;
    this.csrf = null;
    this.home = null;
    this.names = {};
  }

  cookies() {
    return `golden_key=${this.goldenKey}; cookie_prefs=1${this.phpsessid ? `; PHPSESSID=${this.phpsessid}` : ''}`;
  }

  async request(url, { method = 'GET', body, xhr = false } = {}) {
    let link = url;
    for (let hop = 0; hop < 5; hop++) {
      const headers = { cookie: this.cookies(), 'user-agent': this.userAgent, accept: xhr ? '*/*' : 'text/html,*/*' };
      if (xhr) { headers['x-requested-with'] = 'XMLHttpRequest'; headers.origin = 'https://funpay.com'; headers.referer = 'https://funpay.com/chat/'; }
      if (body) headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const response = await this.fetch(link, { method, headers, body, redirect: 'manual' });
      const setCookies = response.headers.getSetCookie?.() || [response.headers.get?.('set-cookie')].filter(Boolean);
      for (const cookie of setCookies) {
        const session = cookie.match(/PHPSESSID=([^;]+)/);
        if (session) this.phpsessid = session[1];
      }
      if (response.status === 429) throw new RateLimitError('FunPay просит реже обращаться (429).');
      const location = response.headers.get?.('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (/account\/login/.test(location)) throw new Error('golden_key не подходит: FunPay просит войти заново.');
        link = new URL(location, link).href;
        method = 'GET'; body = undefined;
        continue;
      }
      if (/account\/login/.test(response.url || '')) throw new Error('golden_key не подходит: FunPay просит войти заново.');
      if (response.status === 403) throw new Error('FunPay ответил 403: golden_key недействителен или доступ заблокирован.');
      if (!response.ok) {
        const detail = (await response.text?.().catch(() => '') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        const error = new Error(`FunPay ответил ${response.status}${detail ? ': ' + detail : ''}.`);
        error.status = response.status;
        throw error;
      }
      return response;
    }
    throw new Error('FunPay: слишком много перенаправлений.');
  }

  async refreshHome() {
    const html = await (await this.request('https://funpay.com/')).text();
    const home = parseHome(html);
    if (!home) throw new Error('golden_key не подходит: FunPay открыл страницу без входа.');
    this.csrf = home.csrf;
    this.home = home;
    return home;
  }

  async profile({ full = true, previous = null } = {}) {
    const home = await this.refreshHome();
    let user = previous && !full ? previous : null;
    let avatar = previous?.avatar || null;
    if (!user || full) {
      user = parseUser(await (await this.request(`https://funpay.com/users/${home.id}/`)).text());
      if (user.avatar && user.avatar !== previous?.avatarUrl) {
        const link = user.avatar.startsWith('http') ? user.avatar : `https://funpay.com${user.avatar}`;
        try {
          const response = await this.fetch(link, { headers: { 'user-agent': this.userAgent } });
          if (response.ok) avatar = `data:${response.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
        } catch { /* без аватарки */ }
      }
    }
    const { csrf, ...publicHome } = home;
    return {
      ...user, ...publicHome, username: user.name || home.username, avatar, avatarUrl: user.avatarUrl ?? user.avatar,
      url: `https://funpay.com/users/${home.id}/`, loadedAt: Date.now(), userLoadedAt: full ? Date.now() : previous?.userLoadedAt
    };
  }

  async runner(objects, request = false) {
    if (!this.csrf) await this.refreshHome();
    const send = () => this.request('https://funpay.com/runner/', {
      method: 'POST', xhr: true,
      body: new URLSearchParams({ objects: JSON.stringify(objects), request: request ? JSON.stringify(request) : 'False', csrf_token: this.csrf }).toString()
    });
    let response;
    try { response = await send(); }
    catch (error) {
      if (error.status !== 400) throw error;
      // 400 обычно значит устаревший csrf/PHPSESSID: берём новую сессию и пробуем ещё раз.
      this.phpsessid = null; this.csrf = null;
      await this.refreshHome();
      response = await send();
    }
    let json = await response.json().catch(() => null);
    if (!json) { await this.refreshHome(); response = await send(); json = await response.json(); }
    return json;
  }

  async chats() {
    const json = await this.runner([{ type: 'chat_bookmarks', id: this.home?.id ?? (await this.refreshHome()).id, tag: randomTag(), data: false }]);
    const object = (json.objects || []).find(item => item.type === 'chat_bookmarks');
    return object?.data?.html ? parseChats(object.data.html) : [];
  }

  async history(node, lastMessage = -1) {
    const json = await this.runner([{ type: 'chat_node', id: node, tag: '00000000', data: { node, last_message: lastMessage, content: '' } }]);
    const object = (json.objects || []).find(item => item.type === 'chat_node' && String(item.data?.node?.id ?? item.id) === String(node));
    if (!object?.data) return { messages: [] };
    return parseMessages(object.data.messages, this.home.id, this.names);
  }

  async send(node, text) {
    const content = String(text || '').trim();
    if (!content) throw new Error('Пустое сообщение.');
    if (content.length > 2000) throw new Error('Сообщение длиннее 2000 символов.');
    const json = await this.runner([], { action: 'chat_message', data: { node, last_message: -1, content } });
    if (!json.response) throw new Error('FunPay не принял сообщение.');
    if (json.response.error) throw new Error(json.response.error);
    return true;
  }
}

module.exports = { FunPaySession, RateLimitError, parseChats, parseMessages };
