// Mobile menu toggle for the stand-in theme (Vuexy's menu.js does this when installed).
document.addEventListener('click', (e) => {
  const t = e.target.closest('.layout-menu-toggle');
  if (t) { e.preventDefault(); document.documentElement.classList.toggle('layout-menu-expanded'); }
});
