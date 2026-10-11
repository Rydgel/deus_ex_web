// Host controls use native popovers for light dismissal and keyboard focus.
// Keep them aligned with their buttons without requiring CSS anchor support.
const menus = [...document.querySelectorAll('.toolbar-popover')].map(menu => ({
  menu, button: document.querySelector(`[popovertarget="${menu.id}"]`),
}));
const isOpen = menu => menu.matches(':popover-open');
function positionMenu(menu, button) {
  const anchor = button.getBoundingClientRect();
  const width = menu.offsetWidth || Math.min(parseFloat(getComputedStyle(menu).width), innerWidth - 16);
  menu.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${anchor.bottom + 8}px`;
  menu.style.maxHeight = `${Math.max(60, innerHeight - anchor.bottom - 16)}px`;
}
function positionMenus() {
  for (const { menu, button } of menus) {
    if (!isOpen(menu)) continue;
    positionMenu(menu, button);
  }
}
export function closeToolbarMenus(returnFocus = false) {
  for (const { menu, button } of menus) {
    if (!isOpen(menu)) continue;
    menu.hidePopover();
    if (returnFocus) button.focus({ preventScroll: true });
  }
}
for (const { menu, button } of menus) {
  menu.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') positionMenu(menu, button);
  });
  menu.addEventListener('toggle', () => {
    button.setAttribute('aria-expanded', String(isOpen(menu)));
    positionMenus();
  });
}
new ResizeObserver(positionMenus).observe(document.querySelector('.toolbar'));
window.addEventListener('resize', positionMenus);
// Escape closes just the host popover, without also opening the game menu.
let escapeHeld = false;
for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
  if (event.code !== 'Escape' || (!escapeHeld && !menus.some(({ menu }) => isOpen(menu)))) return;
  if (type === 'keydown') { closeToolbarMenus(true); escapeHeld = true; }
  else escapeHeld = false;
  event.preventDefault(); event.stopImmediatePropagation();
}, true);
window.addEventListener('blur', () => { escapeHeld = false; });
document.getElementById('tools-menu').addEventListener('click', event => {
  if (event.target.closest('button')) closeToolbarMenus();
});
document.getElementById('preview').addEventListener('change', () => closeToolbarMenus());
