// Pipeline board: draws charts (lazily inside accordions) and remembers which stages are open.
(function () {
  const drawn = new WeakSet();
  const shade = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  function draw(root) {
    if (!window.Chart) return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = '#6b7078';
    root.querySelectorAll('canvas[data-gchart]').forEach((cv) => {
      if (drawn.has(cv) || cv.closest('details:not([open])')) return;
      drawn.add(cv);
      const c = JSON.parse(cv.dataset.gchart);
      const line = c.type === 'line';
      const datasets = c.datasets.map((d) => line
        ? { label: d.label, data: d.data, borderColor: d.color, backgroundColor: d.color, borderDash: d.dash ? [5, 4] : [], cubicInterpolationMode: 'monotone', pointRadius: 3, borderWidth: 2 }
        : { label: d.label, data: d.data, backgroundColor: d.colors || d.color, borderRadius: 4, maxBarThickness: 34 });
      const valueAxis = { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef0f2' } };
      const catAxis = { grid: { display: false }, ticks: { autoSkip: false, callback(v) { const l = this.getLabelForValue(v); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } };
      new Chart(cv, { type: line ? 'line' : 'bar', data: { labels: c.labels, datasets },
        options: { responsive: true, maintainAspectRatio: false, animation: false, indexAxis: c.horizontal ? 'y' : 'x',
          plugins: { legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } },
          scales: c.horizontal ? { x: valueAxis, y: catAxis } : { y: valueAxis, x: line ? { grid: { display: false } } : catAxis } } });
    });
  }
  draw(document);
  const KEY = 'kps.board.open';
  let open; try { open = new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { open = new Set(); }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify([...open])); } catch { /* private mode */ } };
  const accs = [...document.querySelectorAll('details.acc')];
  accs.forEach((d) => {
    if (open.has(d.dataset.cat)) { d.open = true; draw(d); }
    d.addEventListener('toggle', () => { d.open ? open.add(d.dataset.cat) : open.delete(d.dataset.cat); save(); if (d.open) draw(d); });
  });
  document.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', () => accs.forEach((d) => { d.open = b.dataset.acc === 'open'; })));
})();
