const body = document.body;
const menu = document.querySelector('[data-variant-menu]');
const toast = document.querySelector('[data-toast]');
let activeTrigger = null;
let toastTimer = null;

function closeMenu() {
  menu.classList.remove('is-open');
  menu.setAttribute('aria-hidden', 'true');
  activeTrigger = null;
}

function placeMenu(trigger) {
  const rect = trigger.getBoundingClientRect();
  const margin = 10;
  const gap = 6;
  menu.classList.add('is-open');
  menu.setAttribute('aria-hidden', 'false');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
  const top = rect.bottom + gap + height > window.innerHeight - margin
    ? Math.max(margin, rect.top - height - gap)
    : rect.bottom + gap;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showToast(text) {
  toast.querySelector('span').textContent = text;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    closeMenu();
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('is-active', item === button));
    document.querySelectorAll('[data-prototype]').forEach((view) => view.classList.toggle('is-active', view.dataset.prototype === button.dataset.view));
  });
});

document.querySelectorAll('[data-theme]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!button.dataset.theme) return;
    body.dataset.theme = button.dataset.theme;
    document.querySelectorAll('.palette').forEach((item) => item.classList.toggle('is-active', item === button));
    closeMenu();
  });
});

document.querySelectorAll('[data-variant-trigger]').forEach((trigger) => {
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (activeTrigger === trigger && menu.classList.contains('is-open')) return closeMenu();
    activeTrigger = trigger;
    placeMenu(trigger);
  });
});

menu.querySelectorAll('[data-variant]').forEach((item) => {
  item.addEventListener('click', () => {
    const name = item.dataset.variant;
    menu.querySelectorAll('[data-variant]').forEach((other) => {
      other.classList.toggle('is-active', other === item);
      other.querySelector('i').textContent = other === item ? '✓' : '';
    });
    document.querySelectorAll('[data-variant-trigger] span').forEach((label) => { label.textContent = name; });
    document.querySelectorAll('[data-current-label], [data-trace-variant]').forEach((label) => { label.textContent = name; });
    const trace = document.querySelector('[data-trace]');
    trace.classList.remove('is-pulsing');
    requestAnimationFrame(() => trace.classList.add('is-pulsing'));
    closeMenu();
    showToast(`已切换为「${name}」，下一次请求生效`);
  });
});

document.querySelector('[data-advanced]').addEventListener('click', (event) => {
  event.currentTarget.classList.toggle('is-open');
  document.querySelector('[data-advanced-panel]').classList.toggle('is-open');
});

document.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', () => showToast('规则已保存，下一次请求生效')));
document.addEventListener('click', (event) => { if (!menu.contains(event.target)) closeMenu(); });
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
