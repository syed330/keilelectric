// Draws each accordion's charts when it opens and remembers which accordions are open.
(function () {
  const KEY = 'kps.open';
  const accs = [...document.querySelectorAll('details.acc')];
  if (!accs.length) return;
  const charts = new WeakMap();
  const shade = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const money = (v) => '$' + Math.round(v).toLocaleString('en-US');

  function draw(details) {
    if (!window.Chart) return;
    details.querySelectorAll('canvas[data-chart]').forEach((cv) => {
      if (charts.has(cv)) return;
      const c = JSON.parse(cv.dataset.cfg), trend = cv.dataset.chart === 'trend';
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.color = '#6b7078';
      const tick = (v) => (c.amount ? '$' + (v >= 1000 ? (v % 1000 ? (v / 1000).toFixed(1) : v / 1000) + 'k' : v) : v);
      const options = { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: c.series.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
          tooltip: { callbacks: { label: (t) => `${t.dataset.label}: ${c.amount ? money(t.raw) : t.raw}` } } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0, callback: tick }, grid: { color: '#eef0f2' } }, x: { grid: { display: false } } } };
      const datasets = c.series.map((s, i) => trend
        ? { label: s.label, data: s.trend, borderColor: s.color || shade(c.color, i ? 0.45 : 1), backgroundColor: s.color || shade(c.color, i ? 0.45 : 1), borderDash: !s.color && i ? [5, 4] : [], cubicInterpolationMode: 'monotone', pointRadius: 3, borderWidth: 2, spanGaps: false }
        : { label: s.label, data: s.day, backgroundColor: s.color ? shade(s.color, 0.85) : shade(c.color, i ? 0.4 : 0.9), borderRadius: 4, maxBarThickness: 42 });
      if (c.stacked && !trend) { options.scales.x.stacked = true; options.scales.y.stacked = true; }
      charts.set(cv, new Chart(cv, { type: trend ? 'line' : 'bar', data: { labels: trend ? c.weeks : c.days, datasets }, options }));
    });
  }

  let open;
  try { open = new Set(JSON.parse(sessionStorage.getItem(KEY) || 'null') || ['marketing']); } catch { open = new Set(['marketing']); }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify([...open])); } catch { /* private mode */ } };
  accs.forEach((d) => {
    d.open = open.has(d.dataset.cat);
    if (d.open) draw(d);
    d.addEventListener('toggle', () => { d.open ? open.add(d.dataset.cat) : open.delete(d.dataset.cat); save(); if (d.open) draw(d); });
  });
  document.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', () => accs.forEach((d) => { d.open = b.dataset.acc === 'open'; })));
})();
