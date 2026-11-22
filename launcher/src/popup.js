'use strict';
// Уведомления в стиле Telegram: справа снизу, новые сверху над старыми,
// снизу полоска времени, по наведению таймер замирает.
const stack = document.getElementById('stack');
const ICONS = { message: '✉', order: '₽', confirm: '✓', review: '★', raise: '↑', delivered: '📦', error: '!', test: '♪' };
const MAX = 5;
let seconds = 10;

function report() { requestAnimationFrame(() => window.popup.resize(Math.ceil(stack.getBoundingClientRect().height))); }

function remove(card) {
  if (card.classList.contains('leave')) return;
  card.classList.add('leave');
  card.addEventListener('animationend', () => { card.remove(); report(); }, { once: true });
}

function show(event) {
  // Новое сообщение из того же чата заменяет старую карточку, как в Telegram.
  const same = event.chatId && stack.querySelector(`.note[data-chat="${CSS.escape(String(event.chatId))}"]`);
  if (same && event.kind === 'message') same.remove();
  const card = document.createElement('div');
  card.className = 'note'; card.dataset.kind = event.kind;
  if (event.chatId) card.dataset.chat = event.chatId;
  const icon = document.createElement('div'); icon.className = 'icon'; icon.textContent = ICONS[event.kind] || '•';
  const body = document.createElement('div'); body.style.minWidth = '0';
  const app = document.createElement('div'); app.className = 'app'; app.textContent = 'ProjectX · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const head = document.createElement('div'); head.className = 'head';
  const title = document.createElement('span'); title.className = 'title'; title.textContent = event.title || 'ProjectX';
  head.append(title);
  if (event.count > 1) { const count = document.createElement('span'); count.className = 'count'; count.textContent = event.count; head.append(count); }
  const text = document.createElement('div'); text.className = 'text'; text.textContent = event.text || '';
  body.append(app, head, text);
  const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.title = 'Закрыть';
  close.addEventListener('click', e => { e.stopPropagation(); remove(card); });
  const bar = document.createElement('i'); bar.className = 'bar';
  card.append(icon, body, close, bar);
  card.addEventListener('click', () => { window.popup.open(event); remove(card); });

  const animation = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: seconds * 1000, fill: 'forwards' });
  animation.onfinish = () => remove(card);
  card.addEventListener('mouseenter', () => animation.pause());
  card.addEventListener('mouseleave', () => animation.play());

  stack.prepend(card);
  const cards = [...stack.querySelectorAll('.note:not(.leave)')];
  for (const extra of cards.slice(MAX)) remove(extra);
  report();
}

window.popup.onNotify(show);
window.popup.onTheme(theme => {
  seconds = theme.seconds || 10;
  if (theme.accent) document.documentElement.style.setProperty('--accent', theme.accent);
});
