/* ============================================================
   OpenPour — refined dropdown component.
   Wraps a native <select> with a styled trigger + popover list
   (two-line items: title — subtitle). The native select stays in
   the DOM and keeps firing 'change', so existing wiring works;
   dynamic repopulation is picked up by a MutationObserver and
   the option list is rebuilt on every open.
   ============================================================ */

const openSet = new Set();
document.addEventListener('pointerdown', (e) => {
  for (const f of [...openSet]) {
    if (!f.wrap.contains(e.target)) f.close();
  }
});

export function enhanceSelect(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'fsel';
  wrap.style.width = sel.style.width || sel.style.maxWidth || '100%';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const trig = document.createElement('button');
  trig.type = 'button';
  trig.className = 'fsel-trig';
  const panel = document.createElement('div');
  panel.className = 'fsel-panel';
  wrap.append(trig, panel);

  // "Title — subtitle" convention in option text
  const parse = (o) => {
    const ix = o.textContent.indexOf(' — ');
    return ix < 0
      ? { t: o.textContent, s: '' }
      : { t: o.textContent.slice(0, ix), s: o.textContent.slice(ix + 3) };
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  function renderTrig() {
    const o = sel.selectedOptions[0];
    const { t, s } = o ? parse(o) : { t: '—', s: '' };
    trig.innerHTML =
      `<span class="fst"><span class="fst-t">${esc(t)}</span>${s ? `<span class="fst-s">${esc(s)}</span>` : ''}</span>` +
      `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
  }

  function build() {
    panel.innerHTML = '';
    const addOpt = (o) => {
      const it = document.createElement('div');
      it.className = 'fsel-it' + (o.selected ? ' on' : '');
      const { t, s } = parse(o);
      it.innerHTML = `<span class="fst-t">${esc(t)}</span>${s ? `<span class="fst-s">${esc(s)}</span>` : ''}`;
      it.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
        api.close();
      });
      panel.appendChild(it);
    };
    for (const ch of sel.children) {
      if (ch.tagName === 'OPTGROUP') {
        const h = document.createElement('div');
        h.className = 'fsel-g';
        h.textContent = ch.label;
        panel.appendChild(h);
        for (const o of ch.children) addOpt(o);
      } else {
        addOpt(ch);
      }
    }
  }

  const api = {
    wrap,
    close() { wrap.classList.remove('open'); openSet.delete(api); },
    open() { build(); wrap.classList.add('open'); openSet.add(api); },
  };

  trig.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    wrap.classList.contains('open') ? api.close() : api.open();
  });

  sel.addEventListener('change', renderTrig);
  new MutationObserver(renderTrig).observe(sel, { childList: true, subtree: true });
  renderTrig();
  return api;
}
