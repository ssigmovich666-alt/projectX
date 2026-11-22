'use strict';
// Звуки уведомлений ProjectX. Все звуки синтезируются на месте (Web Audio), файлов нет.
// Правило для всех: мягкая атака без щелчка, срез высоких частот, тихий пик — чтобы не резало уши.
(() => {
  let ctx = null, out = null, custom = null;

  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      const soften = ctx.createBiquadFilter(); soften.type = 'lowpass'; soften.frequency.value = 4200; soften.Q.value = 0.3;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -18; limiter.knee.value = 12; limiter.ratio.value = 6; limiter.attack.value = 0.003; limiter.release.value = 0.25;
      out = ctx.createGain();
      out.connect(soften).connect(limiter).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Одна нота: частота, начало, длина, громкость, форма волны, атака, скольжение высоты.
  function tone(f, at, length, level, { type = 'sine', attack = 0.012, glide = 0, detune = 0 } = {}) {
    const now = ctx.currentTime + at;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f, now); osc.detune.value = detune;
    if (glide) osc.frequency.exponentialRampToValueAtTime(f * glide, now + length * 0.6);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    osc.connect(gain).connect(out);
    osc.start(now); osc.stop(now + length + 0.05);
  }

  // Колокольная нота: основной тон и тихий обертон.
  const bell = (f, at, length, level) => { tone(f, at, length, level); tone(f * 2.01, at, length * 0.5, level * 0.18); tone(f * 3.98, at, length * 0.25, level * 0.05); };

  function noise(at, length, level, from, to) {
    const now = ctx.currentTime + at;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource(); source.buffer = buffer;
    const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(from, now); filter.frequency.exponentialRampToValueAtTime(to, now + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + length * 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    source.connect(filter).connect(gain).connect(out);
    source.start(now);
  }

  const LIBRARY = {
    off:     { name: 'Без звука', play() {} },
    drop:    { name: 'Капля', play: v => { tone(880, 0, 0.32, 0.8 * v, { glide: 0.62, attack: 0.006 }); tone(1320, 0.11, 0.22, 0.2 * v, { glide: 0.7, attack: 0.008 }); } },
    bubble:  { name: 'Пузырёк', play: v => { tone(420, 0, 0.16, 0.45 * v, { glide: 1.9 }); tone(620, 0.12, 0.2, 0.3 * v, { glide: 1.6 }); } },
    chime:   { name: 'Колокольчик', play: v => { bell(659.3, 0, 1.1, 0.32 * v); bell(987.8, 0.16, 1.4, 0.26 * v); } },
    glass:   { name: 'Стекло', play: v => { bell(1174.7, 0, 1.3, 0.22 * v); bell(1568, 0.09, 1.5, 0.14 * v); } },
    marimba: { name: 'Маримба', play: v => { for (const [f, t] of [[523.3, 0], [784, 0.12]]) { tone(f, t, 0.45, 0.42 * v, { type: 'sine', attack: 0.004 }); tone(f * 4, t, 0.08, 0.05 * v, { attack: 0.002 }); } } },
    harp:    { name: 'Арфа', play: v => { [392, 493.9, 587.3, 784].forEach((f, i) => tone(f, i * 0.085, 1.2, 0.2 * v, { type: 'triangle', attack: 0.006 })); } },
    kalimba: { name: 'Калимба', play: v => { for (const [f, t] of [[587.3, 0], [880, 0.14], [740, 0.28]]) { tone(f, t, 0.7, 0.3 * v, { attack: 0.003 }); tone(f * 5.4, t, 0.05, 0.03 * v, { attack: 0.002 }); } } },
    pad:     { name: 'Тёплый аккорд', play: v => { for (const f of [261.6, 329.6, 392, 523.3]) { tone(f, 0, 1.6, 0.11 * v, { attack: 0.25, detune: -4 }); tone(f, 0, 1.6, 0.07 * v, { attack: 0.3, detune: 5 }); } } },
    breeze:  { name: 'Ветерок', play: v => { noise(0, 0.9, 0.4 * v, 600, 1800); tone(784, 0.25, 0.9, 0.14 * v, { attack: 0.2 }); } },
    tap:     { name: 'Тихий щелчок', play: v => { tone(1046.5, 0, 0.09, 0.75 * v, { attack: 0.003, glide: 0.8 }); } },
    custom:  { name: 'Свой файл…', async play(v) {
      if (!custom) custom = await window.cardinal.customSound().then(r => r.ok ? r.value : null);
      if (!custom) return;
      const player = new Audio(custom); player.volume = Math.min(1, v); player.play().catch(() => {});
    } }
  };

  window.ProjectXSounds = {
    list: () => Object.entries(LIBRARY).map(([id, sound]) => [id, sound.name]),
    // volume — 0..100 из настроек.
    play(id, volume = 40) {
      const sound = LIBRARY[id];
      if (!sound || id === 'off' || volume <= 0) return;
      const level = Math.pow(volume / 100, 1.6);
      if (id !== 'custom') audio();
      return sound.play(level);
    },
    forgetCustom() { custom = null; }
  };
})();
