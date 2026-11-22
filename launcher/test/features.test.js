const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFunctions, setFunction, readMainConfig, CATALOG, _resetBackup } = require('../src/main-cfg');
const { togglePlugin, listPlugins } = require('../src/cardinal-data');
const { parseHome, parseUser, loadProfile } = require('../src/profile');
const { FunPaySession, RateLimitError, parseChats } = require('../src/funpay');

const CFG = `[FunPay]\ngolden_key : SECRETKEY\nuser_agent : UA\nautoRaise : 1\nautoDelivery : 0\nmultiDelivery : 0\n\n[Telegram]\nenabled : 1\ntoken : TOKEN\nsecretKeyHash : HASH\nblockLogin : 0\n\n[Greetings]\nsendGreetings : 0\ngreetingsText : Привет, $chat_name!\n\tвторая строка\ngreetingsCooldown : 2\n\n[ReviewReply]\nstar5Reply : 0\nstar5ReplyText : \n\n[Other]\nwatermark : \nrequestsDelay : 4\nlanguage : ru\n`;

function bot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpc-f-'));
  fs.mkdirSync(path.join(dir, 'configs')); fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'configs', '_main.cfg'), CFG);
  return dir;
}

test('functions: secrets never exposed, multi-line read', async () => {
  const dir = bot();
  const values = await readFunctions(dir);
  assert.ok(!JSON.stringify(values).includes('SECRETKEY') && !JSON.stringify(values).includes('TOKEN') && !JSON.stringify(values).includes('HASH'));
  assert.strictEqual(values['Greetings.greetingsText'], 'Привет, $chat_name!\nвторая строка');
  assert.strictEqual(values['FunPay.autoRaise'], '1');
  assert.ok(CATALOG.length >= 4);
});

test('functions: write toggle, text, number; keep other lines; backup once', async () => {
  _resetBackup();
  const dir = bot();
  await setFunction(dir, 'FunPay.autoDelivery', true);
  await setFunction(dir, 'Greetings.greetingsText', 'Здравствуйте!\nСтрока 2\nСтрока 3');
  await setFunction(dir, 'ReviewReply.star5ReplyText', 'Спасибо за отзыв');
  await setFunction(dir, 'Other.requestsDelay', '7');
  await setFunction(dir, 'FunPay.keepSentMessagesUnread', false); // отсутствующий ключ дописывается в секцию
  const raw = fs.readFileSync(path.join(dir, 'configs', '_main.cfg'), 'utf8');
  assert.match(raw, /autoDelivery : 1/);
  assert.match(raw, /greetingsText : Здравствуйте!\n\tСтрока 2\n\tСтрока 3\ngreetingsCooldown : 2/);
  assert.match(raw, /golden_key : SECRETKEY/);
  assert.match(raw, /token : TOKEN/);
  assert.match(raw, /star5ReplyText : Спасибо за отзыв\n/);
  assert.match(raw, /requestsDelay : 7/);
  assert.match(raw, /multiDelivery : 0\nkeepSentMessagesUnread : 0\n/);
  const all = await readMainConfig(dir);
  assert.strictEqual(all['Greetings.greetingsText'], 'Здравствуйте!\nСтрока 2\nСтрока 3');
  assert.strictEqual(fs.readdirSync(path.join(dir, 'configs')).filter(f => f.endsWith('.bak')).length, 1);
  await assert.rejects(setFunction(dir, 'FunPay.golden_key', 'x'), /Неизвестная/);
  await assert.rejects(setFunction(dir, 'Other.requestsDelay', '500'), /от 1 до 100/);
  await assert.rejects(setFunction(dir, 'Greetings.greetingsText', '  '), /пустым/);
});

test('plugins: click toggles uuid list and noplug marker', async () => {
  const dir = bot();
  fs.writeFileSync(path.join(dir, 'plugins', 'a.py'), 'NAME = "A"\nUUID = "aaaa"\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'b.py'), '# noplug\r\nNAME = "B"\r\nUUID = "bbbb"\r\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'c.py'), 'NAME = "C"\n');
  let list = await togglePlugin(dir, 'a.py', false);
  assert.strictEqual(list.find(p => p.file === 'a.py').enabled, false);
  list = await togglePlugin(dir, 'b.py', true);
  assert.strictEqual(list.find(p => p.file === 'b.py').enabled, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'plugins', 'b.py'), 'utf8'), 'NAME = "B"\r\nUUID = "bbbb"\r\n');
  list = await togglePlugin(dir, 'b.py', false);
  assert.strictEqual(list.find(p => p.file === 'b.py').enabled, false);
  assert.ok(!fs.readFileSync(path.join(dir, 'plugins', 'b.py'), 'utf8').startsWith('# noplug'), 'uuid plugin disabled via list, file untouched');
  list = await togglePlugin(dir, 'c.py', false);
  assert.ok(fs.readFileSync(path.join(dir, 'plugins', 'c.py'), 'utf8').startsWith('# noplug\n'));
  list = await togglePlugin(dir, 'c.py', true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'plugins', 'c.py'), 'utf8'), 'NAME = "C"\n');
  assert.deepStrictEqual((await listPlugins(dir)).map(p => p.enabled), [false, false, true]);
});

const HOME = `<body data-app-data="{&quot;userId&quot;:123,&quot;csrf-token&quot;:&quot;x&quot;,&quot;locale&quot;:&quot;ru&quot;}"><div class="user-link-name">Alex_shop</div><span class="badge badge-balance">1 245 ₽</span><span class="badge badge-trade">3</span></body>`;
const USER = `<div class="avatar-photo" style="background-image: url(/img/layout/avatar.png);"></div><span class="mr4">Alex_shop</span><span class="media-user-status">Онлайн</span>
<div class="rating-value"><span class="big">4.9</span></div><div class="rating-full-count"><a href="#">152 отзыва</a></div>
<div class="param-item"><h5 class="mb5">Дата регистрации</h5><div class="text-nowrap">5 марта 2023, 14:10<br>2 года назад</div></div>`;

test('profile parsing and loading', async () => {
  assert.deepStrictEqual(parseHome(HOME), { id: 123, username: 'Alex_shop', locale: 'ru', csrf: 'x', balance: '1 245 ₽', activeSales: 3, activePurchases: 0 });
  const user = parseUser(USER);
  assert.strictEqual(user.rating, '4.9');
  assert.strictEqual(user.reviews, 152);
  assert.strictEqual(user.registered, '5 марта 2023, 14:10 · 2 года назад');
  assert.strictEqual(user.online, true);
  const seen = [];
  const fetch = async (url, options) => {
    seen.push([url, options?.headers?.cookie]);
    const body = url.endsWith('funpay.com/') ? HOME : url.includes('/users/') ? USER : 'PNG';
    return { ok: true, status: 200, url, text: async () => body, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => Buffer.from(body) };
  };
  const profile = await loadProfile({ goldenKey: 'K', userAgent: 'UA', fetch });
  assert.strictEqual(profile.username, 'Alex_shop');
  assert.match(profile.avatar, /^data:image\/png;base64,/);
  assert.strictEqual(seen[2][1], undefined, 'golden_key is not sent to the avatar host');
  assert.ok(!JSON.stringify(profile).includes('golden_key=K'));
  await assert.rejects(loadProfile({ goldenKey: '', fetch }), /нет golden_key/);
  const login = async url => ({ ok: true, status: 200, url: 'https://funpay.com/account/login', text: async () => '' });
  await assert.rejects(loadProfile({ goldenKey: 'K', fetch: login }), /не подходит/);
});

const CHATS_HTML = `<a href="https://funpay.com/chat/?node=555" class="contact-item unread" data-id="555" data-node-msg="9001" data-user-msg="9000"><div class="contact-item-photo"><div class="avatar-photo" style="background-image: url(/img/a.jpg);"></div></div><div class="media-user-name">Buyer1</div><div class="contact-item-message">\u2061Спасибо за покупку</div><div class="contact-item-time">14:20</div></a><a href="x" class="contact-item" data-id="556" data-node-msg="1" data-user-msg="1"><div class="media-user-name">Buyer2</div><div class="contact-item-message">привет</div><div class="contact-item-time">Вчера</div></a>`;
function mockFetch(log, overrides = {}) {
  return async (url, options = {}) => {
    log.push({ url, options });
    if (overrides[url]) return overrides[url](url, options);
    let body = 'x', type = 'text/html', status = 200, cookies = [];
    if (url === 'https://funpay.com/') { body = HOME; cookies = ['PHPSESSID=abc; path=/']; }
    else if (url.includes('/users/')) body = USER;
    else if (url.endsWith('/runner/')) {
      const form = new URLSearchParams(options.body);
      const objects = JSON.parse(form.get('objects'));
      const request = form.get('request') === 'False' ? null : JSON.parse(form.get('request'));
      const out = [];
      for (const o of objects) {
        if (o.type === 'chat_bookmarks') out.push({ type: 'chat_bookmarks', data: { html: CHATS_HTML } });
        if (o.type === 'chat_node') out.push({ type: 'chat_node', id: o.id, data: { node: { id: o.id, name: 'users-123-777', silent: false }, messages: [
          { id: 1, author: 777, html: '<div class="chat-msg-item"><div class="media-user-name"><a href="#">Buyer1</a></div><div class="chat-msg-date" title="21 ноября, 14:20:00">14:20</div><div class="chat-msg-text">Здравствуйте!<br>Есть мишка?</div></div>' },
          { id: 2, author: 123, html: '<div class="chat-msg-item"><div class="media-user-name"><a href="#">Alex_shop</a></div><div class="chat-msg-text">\u2061Да, есть</div></div>' },
          { id: 3, author: 0, html: '<div class="chat-msg-item"><div class="alert alert-with-icon alert-info" role="alert">Покупатель оплатил заказ</div></div>' }
        ].filter(m => m.id > o.data.last_message) } });
      }
      body = JSON.stringify({ objects: out, response: request ? (request.data.content === 'flood' ? { error: 'Нельзя отправлять сообщения слишком часто.' } : { error: null }) : false });
      type = 'application/json';
    }
    const headers = new Map([['content-type', type]]);
    return { ok: status < 400, status, url, headers: { get: k => headers.get(k), getSetCookie: () => cookies }, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => Buffer.from(body) };
  };
}

test('funpay session: profile, chats, history, send', async () => {
  const log = [];
  const fp = new FunPaySession({ goldenKey: 'KEY', userAgent: 'UA', fetch: mockFetch(log) });
  const profile = await fp.profile({ full: true });
  assert.strictEqual(profile.username, 'Alex_shop');
  assert.strictEqual(profile.rating, '4.9');
  assert.ok(!('csrf' in profile) && !JSON.stringify(profile).includes('KEY'));
  const light = await fp.profile({ full: false, previous: profile });
  assert.strictEqual(light.reviews, 152);
  assert.strictEqual(log.filter(l => l.url.includes('/users/')).length, 1, 'user page only on full refresh');
  const chats = await fp.chats();
  assert.deepStrictEqual(chats.map(c => [c.id, c.name, c.last, c.unread]), [[555, 'Buyer1', 'Спасибо за покупку', true], [556, 'Buyer2', 'привет', false]]);
  const runnerCall = log.find(l => l.url.endsWith('/runner/'));
  assert.match(runnerCall.options.headers.cookie, /PHPSESSID=abc/);
  assert.strictEqual(new URLSearchParams(runnerCall.options.body).get('csrf_token'), 'x');
  const { messages } = await fp.history(555);
  assert.deepStrictEqual(messages.map(m => [m.id, m.author, m.mine, m.system, m.text, m.byBot]), [
    [1, 'Buyer1', false, false, 'Здравствуйте!\nЕсть мишка?', false], [2, 'Alex_shop', true, false, 'Да, есть', true], [3, 'FunPay', false, true, 'Покупатель оплатил заказ', false]]);
  assert.strictEqual((await fp.history(555, 2)).messages.length, 1);
  assert.strictEqual(await fp.send(555, 'Привет'), true);
  const sent = JSON.parse(new URLSearchParams(log.at(-1).options.body).get('request'));
  assert.deepStrictEqual(sent, { action: 'chat_message', data: { node: 555, last_message: -1, content: 'Привет' } });
  await assert.rejects(fp.send(555, 'flood'), /слишком часто/);
  await assert.rejects(fp.send(555, '   '), /Пустое/);
  const limited = new FunPaySession({ goldenKey: 'KEY', fetch: mockFetch([], { 'https://funpay.com/': async url => ({ ok: false, status: 429, url, headers: { get: () => null, getSetCookie: () => [] } }) }) });
  await assert.rejects(limited.profile(), RateLimitError);
  const loggedOut = new FunPaySession({ goldenKey: 'KEY', fetch: mockFetch([], { 'https://funpay.com/': async url => ({ ok: false, status: 302, url, headers: { get: k => k === 'location' ? 'https://funpay.com/account/login' : null, getSetCookie: () => [] } }) }) });
  await assert.rejects(loggedOut.profile(), /войти заново/);
});
