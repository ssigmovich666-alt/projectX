// A fixed terminal grid keeps the letters aligned while the eye moves beneath them.
const consoleIntro = (() => {
  const canvas = document.getElementById('console-intro');
  const box = canvas.parentElement;
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const duration = 10000;
  const revealDuration = 3000;
  const lines = document.getElementById('matrix-lines');
  const hiddenText = new Highlight();
  const graphemes = new Intl.Segmenter(undefined, {granularity:'grapheme'});
  let schedules = new WeakMap();
  const chars = '·.,:;i+=ox%#@';
  const colors = ['#45323a','#74504d','#ac7161','#df9d82','#b4a6aa','#e5d5cd',
    '#75431e','#ab641c','#d59836','#ffd471','#262336','#a193a5'];
  const tile = 12;
  const atlas = document.createElement('canvas');
  atlas.width = chars.length * tile;
  atlas.height = (colors.length + 1) * tile;
  const ink = atlas.getContext('2d');
  ink.font = 'bold 12px monospace';
  ink.textAlign = 'center';
  function paintRow(color, row) {
    ink.clearRect(0, row * tile, atlas.width, tile);
    ink.fillStyle = color;
    Array.from(chars).forEach((ch, col) => ink.fillText(ch, (col + .5) * tile, row * tile + 10));
  }
  colors.forEach(paintRow);
  let accent;

  const smooth = x => { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); };
  let run, frame, cleanup;
  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(cleanup);
    canvas.hidden = true;
    box.classList.remove('playing');
    CSS.highlights.delete('console-pending');
    hiddenText.clear();
    schedules = new WeakMap();
  }

  function revealText(progress) {
    const viewport = lines.getBoundingClientRect();
    for (const row of lines.children) {
      const rect = row.getBoundingClientRect();
      if (rect.top >= viewport.bottom) break;
      const text = row.firstChild;
      if (rect.bottom <= viewport.top || !text || !text.length) continue;
      let pending = schedules.get(text);
      if (!pending) {
        pending = [];
        for (const {segment, index} of graphemes.segment(text.data)) {
          if (!segment.trim()) continue;
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + segment.length);
          hiddenText.add(range);
          pending.push({range, at: progress + Math.random() * (1 - progress)});
        }
        pending.sort((a, b) => b.at - a.at);
        schedules.set(text, pending);
      }
      while (pending.length && pending[pending.length - 1].at <= progress) {
        hiddenText.delete(pending.pop().range);
      }
    }
  }

  function paint(t) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const scale = Math.min(devicePixelRatio, 1600 / Math.max(w, h));
    const width = Math.round(w * scale), height = Math.round(h * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    const themeColor = getComputedStyle(canvas).getPropertyValue('--accent').trim();
    if (themeColor !== accent) {
      accent = themeColor;
      paintRow(accent, colors.length);
    }
    ctx.fillStyle = '#141217';
    ctx.fillRect(0, 0, width, height);
    const unit = Math.min(width, height);
    const cols = Math.min(220, Math.ceil(94 * width / unit));
    const rows = Math.min(128, Math.ceil(63 * height / unit));
    const dx = width / cols, dy = height / rows;
    const opening = smooth(t / .32);
    const zoom = Math.exp(3.05*smooth((t-.22)/.67));
    const letterSize = .034 * zoom;
    for (let j=0; j<rows; j++) {
      const y = ((j+.5)/rows*2-1) * height / unit;
      for (let i=0; i<cols; i++) {
        const x = ((i+.5)/cols*2-1) * width / unit;
        const u=x/zoom, v=y/zoom;
                const r=Math.hypot(u,v);
        const angle=Math.atan2(v,u);
        const noise=((i*71+j*109+i*j*7)%97)/97;
        let glyph=Math.floor(noise*chars.length), color;
        const lid=opening*.60*(1-.59*u*u);
        if (Math.abs(v+.035*u*u)>lid) {
          const ridge=Math.cos((v+u*u*.09)*42);
          color=Math.abs(v)-lid<.04 ? 0 : Math.min(3,Math.floor(1.4+ridge*.85+noise*.8));
        } else if (r>.48) {
          color=noise>.4 ? 5 : 4;
        } else if (r>.22) {
          const fibers = Math.sin(angle*61 + r*37) + .45*Math.sin(angle*113 - r*52);
          const rings = .55*Math.sin(r*148 + Math.sin(angle*12)*1.8);
          const glint = Math.hypot(u+.15, v+.18);
          color = r>.455 || r<.24 ? 6 : Math.max(6,Math.min(9,Math.round(7.6+fibers+rings+noise*.7)));
          glyph = Math.max(1, Math.min(chars.length-1, Math.round(5+fibers*3+rings*2+noise*3)));
          if (glint < .052) { color = 5; glyph = glint < .024 ? 12 : 9; }
        } else {
          // Persistent star positions expand outward with the pupil.
          const sx=Math.floor(u*110), sy=Math.floor(v*110);
          const star=Math.sin(sx*127.1+sy*311.7)*43758.5453;
          if (star-Math.floor(star)>.954 && Math.abs(u*110-sx-.5)<.19 && Math.abs(v*110-sy-.5)<.19) {
            color=11; glyph=5;
          } else { color=10; glyph=0; }
          const ax=Math.abs(x)/letterSize, ay=Math.abs(y)/letterSize;
          if (t>.38 && ay<=1 && Math.abs(ax-.78*ay)<.15) {
            color=colors.length; glyph=9+Math.floor(noise*4);
          }
        }
        ctx.drawImage(atlas,glyph*tile,color*tile,tile,tile,i*dx,j*dy,dx,dy);
      }
    }
  }

  reduced.addEventListener('change', () => { if (reduced.matches) stop(); });
  new MutationObserver(() => {
    if (document.documentElement.hasAttribute('data-static')) stop();
  }).observe(document.documentElement,{attributes:true,attributeFilter:['data-static']});

  return status => {
    if (!status.running) { stop(); run=null; return; }
    if (run===status.startedAt) return;
    run=status.startedAt;
    stop();
    if (!ctx || Date.now()-run>4500 || reduced.matches || document.documentElement.hasAttribute('data-static')) return;
    canvas.hidden=false;
    box.classList.add('playing');
    const start=performance.now();
    let last=-100;
    function tick(now) {
      const elapsed=now-start;
      if (elapsed >= duration + revealDuration) { stop(); return; }
      if (elapsed<duration) {
        if (elapsed-last>=32) { paint(elapsed/duration); last=elapsed; }
      } else {
        if (box.classList.contains('playing')) {
          CSS.highlights.set('console-pending', hiddenText);
          box.classList.remove('playing');
          cleanup=setTimeout(() => { canvas.hidden=true; },500);
          last=-100;
        }
        if (elapsed-last>=32) { revealText((elapsed-duration)/revealDuration); last=elapsed; }
      }
      frame=requestAnimationFrame(tick);
    }
    frame=requestAnimationFrame(tick);
  };
})();
