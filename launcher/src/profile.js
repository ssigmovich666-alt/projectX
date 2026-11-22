// Профиль FunPay по golden_key из _main.cfg. Ключ используется только как cookie в запросе к funpay.com,
// никуда не пишется и не уходит в окно лаунчера.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return ENTITIES[code] ?? all;
});
const plain = html => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const pick = (html, ...patterns) => {
  for (const pattern of patterns) { const match = html.match(pattern); if (match) return match[1]; }
  return null;
};

function parseHome(html) {
  const appData = pick(html, /data-app-data="([^"]+)"/);
  const username = pick(html, /<div class="user-link-name">([^<]+)<\/div>/);
  if (!appData || !username) return null;
  const data = JSON.parse(decode(appData));
  return {
    id: data.userId, username: decode(username).trim(), locale: data.locale, csrf: data['csrf-token'],
    balance: plain(pick(html, /<span class="badge badge-balance">([^<]+)<\/span>/) || '') || null,
    activeSales: Number(pick(html, /<span class="badge badge-trade">(\d+)<\/span>/) || 0),
    activePurchases: Number(pick(html, /<span class="badge badge-orders">(\d+)<\/span>/) || 0)
  };
}

function parseUser(html) {
  const avatar = pick(html, /class="avatar-photo"[^>]*style="[^"]*url\(([^)]+)\)/, /class="profile-photo"[^>]*style="[^"]*url\(([^)]+)\)/);
  const status = plain(pick(html, /<span class="media-user-status">([\s\S]*?)<\/span>/) || '');
  const registered = pick(html,
    /(?:Дата регистрации|Registration date|Дата реєстрації)\s*<\/h5>\s*<div[^>]*>([\s\S]*?)<\/div>/i,
    /(?:Дата регистрации|Registration date|Дата реєстрації)[\s\S]{0,80}?<div[^>]*>([\s\S]*?)<\/div>/i);
  const rating = pick(html, /class="rating-value"[^>]*>\s*<span class="big">([\d.,]+)<\/span>/, /<span class="big">([\d.,]+)<\/span>/);
  const reviewsBlock = pick(html, /class="rating-full-count"[^>]*>([\s\S]*?)<\/div>/);
  const reviews = (reviewsBlock && plain(reviewsBlock).match(/(\d[\d\s]*)/)?.[1])
    || pick(html, /(\d[\d\s ]*)\s*(?:отзыв|review|відгук)/i);
  return {
    name: plain(pick(html, /<span class="mr4">([^<]+)<\/span>/) || '') || null,
    avatar: avatar ? decode(avatar.replace(/^['"]|['"]$/g, '')) : null,
    online: /Онлайн|Online/.test(status), status: status || null,
    registered: registered ? plain(registered).replace(/\n/g, ' · ') : null,
    rating: rating ? rating.replace(',', '.') : null,
    reviews: reviews ? Number(String(reviews).replace(/\D/g, '')) : null,
    banned: /<span class="label label-danger">/.test(html)
  };
}

async function loadProfile({ goldenKey, userAgent, fetch }) {
  if (!goldenKey) throw new Error('В configs/_main.cfg нет golden_key.');
  const headers = { cookie: `golden_key=${goldenKey}; cookie_prefs=1`, 'user-agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36' };
  const get = async url => {
    const response = await fetch(url, { headers, redirect: 'follow' });
    if (/account\/login/.test(response.url)) throw new Error('golden_key не подходит: FunPay просит войти заново.');
    if (response.status === 403) throw new Error('FunPay ответил 403: golden_key недействителен или доступ заблокирован.');
    if (!response.ok) throw new Error(`FunPay ответил ${response.status}.`);
    return response;
  };
  const home = parseHome(await (await get('https://funpay.com/')).text());
  if (!home) throw new Error('golden_key не подходит: FunPay открыл страницу без входа.');
  const user = parseUser(await (await get(`https://funpay.com/users/${home.id}/`)).text());
  let avatar = null;
  if (user.avatar) {
    const link = user.avatar.startsWith('http') ? user.avatar : `https://funpay.com${user.avatar}`;
    try {
      const response = await fetch(link, { headers: { 'user-agent': headers['user-agent'] } });
      if (response.ok) {
        const type = response.headers.get('content-type') || 'image/jpeg';
        avatar = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
      }
    } catch { /* без аватарки */ }
  }
  const { csrf, ...publicHome } = home;
  return { ...publicHome, ...user, username: user.name || home.username, avatar, url: `https://funpay.com/users/${home.id}/`, loadedAt: Date.now() };
}

module.exports = { loadProfile, parseHome, parseUser, decode, plain };
