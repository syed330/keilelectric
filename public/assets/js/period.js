// Period bar: "Custom" opens the date/time panel in place; the panel checks that the end is after the start.
(function () {
  document.querySelectorAll('.periodbar').forEach((bar) => {
    // on narrow screens, scroll the preset row so the selected button is visible
    const row = bar.querySelector('.pb-presets'), active = row && row.querySelector('.is-active');
    if (row && active && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, active.offsetLeft - row.clientWidth / 2 + active.offsetWidth / 2);

    const toggle = bar.querySelector('[data-custom-toggle]');
    const panel = bar.querySelector('.pb-custom');
    if (!toggle || !panel) return;
    const setOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.classList.toggle('is-open', open);
      if (open) panel.querySelector('input[type=date]').focus();
    };
    toggle.addEventListener('click', (e) => { e.preventDefault(); setOpen(panel.hidden); });
    const cancel = panel.querySelector('[data-custom-cancel]');
    if (cancel) cancel.addEventListener('click', (e) => { e.preventDefault(); setOpen(false); toggle.focus(); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cancel) { setOpen(false); toggle.focus(); } });

    const [fd, ft, td, tt] = ['from_date', 'from_time', 'to_date', 'to_time'].map((n) => panel.querySelector(`[name=${n}]`));
    const stamp = (d, t, dflt) => (d.value ? `${d.value}T${t.value || dflt}` : '');
    const check = () => {
      td.setCustomValidity('');
      const a = stamp(fd, ft, '00:00'), b = stamp(td, tt, '23:59');
      if (a && b && b < a) td.setCustomValidity('The end must be after the start.');
    };
    [fd, ft, td, tt].forEach((i) => i.addEventListener('input', check));
    fd.addEventListener('change', () => { td.min = fd.value; });
    td.min = fd.value;
    panel.addEventListener('submit', (e) => { check(); if (!panel.checkValidity()) { e.preventDefault(); panel.reportValidity(); } });
  });
})();
