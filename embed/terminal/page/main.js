/**
 * A UNATCO network terminal: the original ComputerScreenLogin and
 * ComputerScreenEmail windows, laid out with their scripts' constants and
 * drawn from the original textures and fonts (assets/ui.json, written by
 * build.mjs). Comments name the DeusEx.u classes each part follows; what is
 * approximated is listed in embed/terminal/README.md.
 *
 * ?poster draws the card's still frame.
 */
import {openAccount} from './story-crypto.js';

const json = file => fetch(`assets/${file}`).then(r => {
  if (!r.ok) throw new Error(`${file}: ${r.status}`);
  return r.json();
});
const [ui, records] = await Promise.all([json('ui.json'), json('accounts.json')]);
const options = new URLSearchParams(location.search);
const poster = options.has('poster');
const colors = ui.colors, WHITE = [255, 255, 255];

const images = new Map();
{
  const files = new Set();
  (function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.file === 'string') files.add(value.file);
    Object.values(value).forEach(collect);
  })(ui);
  await Promise.all([...files].map(file => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { images.set(file, image); resolve(); };
    image.onerror = () => reject(new Error(`assets/${file}`));
    image.src = `assets/${file}`;
  })));
}

const canvas = document.getElementById('screen'), ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const userField = document.getElementById('user'), passwordField = document.getElementById('password');

// ---- GC drawing --------------------------------------------------------

/** DSTY_Masked with SetTileColor: texel × tile colour; palette index 0 is already transparent. */
const tints = new Map();
function tinted(texture, color) {
  const key = `${texture.file}|${color}`;
  let result = tints.get(key);
  if (!result) {
    const image = images.get(texture.file);
    result = document.createElement('canvas');
    result.width = image.width; result.height = image.height;
    const g = result.getContext('2d');
    g.drawImage(image, 0, 0);
    if (String(color) !== String(WHITE)) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = `rgb(${color.join(',')})`;
      g.fillRect(0, 0, result.width, result.height);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(image, 0, 0);
    }
    tints.set(key, result);
  }
  return result;
}
/** GC.DrawTexture: the (u, v) region of the texture, unscaled. */
function drawTexture(texture, color, x, y, width, height, u = 0, v = 0) {
  const w = Math.min(width, texture.width - u), h = Math.min(height, texture.height - v);
  if (w > 0 && h > 0) ctx.drawImage(tinted(texture, color), u, v, w, h, x, y, w, h);
}
/** GC.DrawPattern: the texture tiled over the rectangle. */
function drawPattern(texture, color, x, y, width, height) {
  const source = tinted(texture, color);
  for (let ty = 0; ty < height; ty += texture.height) {
    for (let tx = 0; tx < width; tx += texture.width) {
      const w = Math.min(texture.width, width - tx), h = Math.min(texture.height, height - ty);
      ctx.drawImage(source, 0, 0, w, h, x + tx, y + ty, w, h);
    }
  }
}
/** A window background: the whole texture stretched over the window. */
function drawStretched(texture, color, x, y, width, height) {
  ctx.drawImage(tinted(texture, color), 0, 0, texture.width, texture.height, x, y, width, height);
}
function fillRect(color, x, y, width, height) {
  ctx.fillStyle = `rgb(${color.join(',')})`;
  ctx.fillRect(x, y, width, height);
}

// ---- Bitmap fonts --------------------------------------------------------

const fonts = Object.fromEntries(Object.entries(ui.fontData).map(([name, font]) => {
  const all = font.pages.flatMap(page => page.glyphs);
  return [name, {...font, height: Math.max(...all.filter(g => g[2] > 0).map(g => g[3]))}];
}));
function glyph(font, code) {
  const page = font.pages[Math.floor(code / font.charsPerPage)];
  const g = page?.glyphs[code % font.charsPerPage];
  return g && g[2] > 0 ? {texture: page.texture, rect: g} : null;
}
function measure(fontName, text) {
  const font = fonts[fontName];
  let width = 0;
  for (const ch of text) width += glyph(font, ch.charCodeAt(0))?.rect[2] ?? 0;
  return width;
}
function wrapLines(fontName, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(fontName, candidate) > width) { lines.push(line); line = word; }
      else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}
/** GC.DrawText into a box, clipped to it. Returns the text block's height. */
function drawText(fontName, text, x, y, width, height, color, {hAlign = 'left', vAlign = 'top', wrap = false, scroll = 0} = {}) {
  const font = fonts[fontName];
  const lines = wrap ? wrapLines(fontName, text, width) : text.split('\n');
  const blockHeight = lines.length * font.height;
  let top = vAlign === 'center' ? y + Math.floor((height - blockHeight) / 2) : y;
  top -= scroll;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  lines.forEach((line, row) => {
    let left = hAlign === 'center' ? x + Math.floor((width - measure(fontName, line)) / 2) : x;
    for (const ch of line) {
      const g = glyph(font, ch.charCodeAt(0));
      if (!g) continue;
      const [u, v, w, h] = g.rect;
      ctx.drawImage(tinted(g.texture, color), u, v, w, h, left, top + row * font.height, w, h);
      left += w;
    }
  });
  ctx.restore();
  return blockHeight;
}

// ---- Menu UI windows ----------------------------------------------------

/** MenuUIBorderButtonWindow.DrawWindow, with SetButtonMetrics' states. */
function drawButton(kind, {x, y, width, label = '', enabled = true, pressed = false, focus = false}) {
  const b = ui.buttons[kind];
  const index = enabled && pressed ? 1 : 0, offset = enabled && pressed && b.useTextOffset ? 1 : 0;
  const text = !enabled ? colors.ButtonTextDisabled : pressed || focus ? colors.ButtonTextFocus : colors.ButtonTextNormal;
  const left = b.left[index], center = b.center[index], right = b.right[index];
  drawTexture(left.texture, colors.ButtonFace, x, y, left.width, b.height);
  drawPattern(center.texture, colors.ButtonFace, x + left.width, y, width - left.width - right.width, b.height);
  drawTexture(right.texture, colors.ButtonFace, x + width - right.width, y, right.width, b.height);
  if (label) drawText(b.font, label, x + b.textLeftMargin + offset, y + b.verticalTextMargin + offset, width, b.height, text, {vAlign: 'center'});
}

/** ComputerUIWindow: title, client, button bar and status, placed as ConfigurationChanged does. */
function computerWindow(screen, title, buttons) {
  const t = ui.title, bar = ui.buttons;
  const titleWidth = Math.max(t.minimumWidth, t.leftMargin + measure(t.font, title) + t.rightMargin);
  const client = {x: t.leftBottomWidth, y: t.height, width: screen.clientWidth, height: screen.clientHeight};
  const buttonBar = {x: client.x, y: client.y + client.height, width: client.width - 1, height: bar.barHeight};
  // MenuUIActionButtonBarWindow.ConfigurationChanged: right-aligned buttons fill from the right.
  let leftX = 0, rightX = buttonBar.width;
  for (const button of buttons) {
    const b = bar.action;
    button.width = Math.max(b.minimumWidth, b.left[0].width + measure(b.font, button.label) + b.right[0].width);
    if (button.align === 'right') { rightX -= button.width; button.x = buttonBar.x + rightX; rightX -= bar.spacing; }
    else { button.x = buttonBar.x + leftX; leftX += bar.spacing + button.width; }
    button.y = buttonBar.y + 1;
    button.height = b.height;
  }
  return {screen, title, titleWidth, client, buttons,
    status: {x: client.x + screen.statusLeftOffset, y: t.height + screen.statusPosY,
      width: client.width - screen.statusClientDiffY, height: screen.statusHeight},
    width: Math.max(titleWidth, client.x + client.width), height: buttonBar.y + buttonBar.height};
}
function drawComputerWindow(win) {
  const t = ui.title, tex = t.textures, face = colors.ButtonFace, bubble = colors.TitleBackground;
  const centerWidth = win.titleWidth - t.leftWidth - t.rightWidth;
  // MenuUITitleWindow.DrawWindow: the frame in ButtonFace, the bubble in TitleBackground.
  drawTexture(tex.titleTexture_Left, face, 0, 0, t.leftWidth, t.height);
  drawTexture(tex.titleTexture_LeftBottom, face, 0, t.height - 1, t.leftBottomWidth, t.leftBottomHeight);
  drawPattern(tex.titleTexture_Center, face, t.leftWidth, 0, centerWidth, t.height);
  drawTexture(tex.titleTexture_Right, face, win.titleWidth - t.rightWidth, 0, t.rightWidth, t.height);
  drawTexture(tex.titleBubble_Left, bubble, 0, 0, t.leftWidth, t.height);
  drawPattern(tex.titleBubble_Center, bubble, t.leftWidth, 0, centerWidth, t.height);
  drawTexture(tex.titleBubble_Right, bubble, win.titleWidth - t.rightWidth, 0, t.rightWidth, t.height);
  drawText(t.font, win.title, t.leftMargin, 0, win.titleWidth - t.leftMargin, t.height, colors.TitleText, {vAlign: 'center'});
  drawStretched(t.icon, WHITE, 12, 3, 16, 16); // CreateIconWindow
  // MenuUIClientWindow.DrawWindow: 256-pixel tiles, masked, in MenuColor_Background.
  win.screen.clientTextures.forEach((texture, i) => drawTexture(texture, colors.Background,
    win.client.x + (i % win.screen.textureCols) * 256, win.client.y + Math.floor(i / win.screen.textureCols) * 256,
    texture.width, texture.height));
  for (const button of win.buttons) drawButton('action', button);
  const s = win.status;
  drawText(ui.fonts.help, ui.status + win.screen.functionLabel, s.x, s.y, s.width, s.height, colors.HelpText, {vAlign: 'center'});
}

// ---- Screens -------------------------------------------------------------

let state = {screen: 'login', info: ui.node.description};
let layout;
const pointer = {x: -1, y: -1, down: null};

function loginWindow() {
  const buttons = [
    {id: 'cancel', label: ui.labels.cancel, align: 'right', enabled: true},
    {id: 'login', label: ui.labels.login, align: 'right', enabled: !!(userField.value && passwordField.value)},
  ];
  return computerWindow(ui.screens.login, ui.screens.login.title.replace('%s', ui.node.name), buttons);
}
function emailWindow() {
  return computerWindow(ui.screens.email, ui.screens.email.title, [{id: 'logout', label: ui.labels.logout, align: 'right', enabled: true}]);
}

// ComputerScreenLogin.CreateControls: edit fields sit in insensitive MenuUIInfoButtonWindows.
const EDITS = [{field: userField, x: 105, y: 20, width: 143}, {field: passwordField, x: 105, y: 54, width: 143}];
let caretEpoch = performance.now();

function drawLogin(win) {
  const c = win.client;
  drawText(ui.fonts.label, ui.labels.userName, c.x + 10, c.y + 22, 100, 20, colors.ListText);
  drawText(ui.fonts.label, ui.labels.password, c.x + 10, c.y + 55, 100, 20, colors.ListText);
  for (const edit of EDITS) {
    drawButton('info', {x: c.x + edit.x, y: c.y + edit.y, width: edit.width, enabled: false});
    // CreateMenuEditWindow: a ClipWindow 8 narrower, 4 in from the frame.
    const box = {x: c.x + edit.x + 4, y: c.y + edit.y + 4, width: edit.width - 8, height: fonts[ui.fonts.edit].height};
    const text = edit.field.value, caretAt = measure(ui.fonts.edit, text.slice(0, edit.field.selectionStart ?? text.length));
    const scroll = Math.max(0, caretAt - box.width + 1);
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip();
    drawText(ui.fonts.edit, text, box.x - scroll, box.y, box.width + scroll, box.height, colors.ListText);
    const blinkOn = poster || Math.floor((performance.now() - caretEpoch) / 500) % 2 === 0;
    if (document.activeElement === edit.field && blinkOn) fillRect(colors.Cursor, box.x - scroll + caretAt, box.y, 1, box.height);
    ctx.restore();
  }
  drawStretched(ui.node.logo, WHITE, c.x + 276, c.y + 5, 61, 61); // CreateLogo, DSTY_Masked background
  drawText(ui.fonts.small, state.info, c.x + 10, c.y + 97, 320, 25, colors.ListText, {vAlign: 'center'}); // CreateLoginInfoWindow
}

const LIST = {x: 11, y: 22, width: 373, height: 73, columns: [123, 250]};
const BODY = {x: 11, y: 136, width: 373, height: 239};
function rowHeight() { return fonts[ui.fonts.list].height + 2; }

function drawEmail(win) {
  const c = win.client, mail = state.account.emails, selected = mail[state.selected];
  // CreateHeaderButtons
  drawButton('header', {x: c.x + 10, y: c.y + 3, width: 121, label: ui.labels.headerFrom});
  drawButton('header', {x: c.x + 134, y: c.y + 3, width: 187, label: ui.labels.headerSubject});
  // MenuUIListWindow: From and Subject columns, the selected row highlighted.
  ctx.save();
  ctx.beginPath(); ctx.rect(c.x + LIST.x, c.y + LIST.y, LIST.width, LIST.height); ctx.clip();
  mail.forEach((message, row) => {
    const y = c.y + LIST.y + row * rowHeight() - state.listScroll;
    const isSelected = row === state.selected;
    if (isSelected) fillRect(colors.ListHighlight, c.x + LIST.x, y, LIST.width, rowHeight());
    const color = isSelected ? colors.ListTextHighlight : colors.ListText;
    drawText(ui.fonts.list, message.from, c.x + LIST.x + 2, y + 1, LIST.columns[0] - 4, rowHeight(), color);
    drawText(ui.fonts.list, message.subject, c.x + LIST.x + LIST.columns[0] + 2, y + 1, LIST.columns[1] - 4, rowHeight(), color);
  });
  ctx.restore();
  if (!selected) {
    drawText(ui.fonts.body, ui.labels.noEmail, c.x + BODY.x, c.y + BODY.y, BODY.width, BODY.height, colors.ListText, {hAlign: 'center', vAlign: 'center'});
    return;
  }
  // CreateEmailHeaders
  drawText(ui.fonts.label, ui.labels.from, c.x + 12, c.y + 104, 40, 14, colors.ListText);
  drawText(ui.fonts.label, ui.labels.to, c.x + 212, c.y + 104, 30, 14, colors.ListText);
  drawText(ui.fonts.label, ui.labels.subject, c.x + 12, c.y + 118, 40, 14, colors.ListText);
  drawText(ui.fonts.small, selected.from, c.x + 50, c.y + 105, 160, 12, colors.ListText);
  drawText(ui.fonts.small, selected.to, c.x + 240, c.y + 105, 140, 12, colors.ListText);
  drawText(ui.fonts.small, selected.subject, c.x + 50, c.y + 119, selected.cc ? 160 : 330, 12, colors.ListText);
  if (selected.cc) {
    drawText(ui.fonts.label, ui.labels.cc, c.x + 212, c.y + 118, 30, 14, colors.ListText);
    drawText(ui.fonts.small, selected.cc, c.x + 240, c.y + 119, 140, 12, colors.ListText);
  }
  // CreateEmailViewWindow: word-wrapped, margins (4, 1).
  const box = {x: c.x + BODY.x + 4, y: c.y + BODY.y + 1, width: BODY.width - 8, height: BODY.height - 2};
  state.bodyHeight = drawText(ui.fonts.body, selected.body, box.x, box.y, box.width, box.height, colors.ListText, {wrap: true, scroll: state.bodyScroll});
  state.bodyMax = Math.max(0, state.bodyHeight - box.height);
  if (state.bodyMax) {
    const track = box.height, thumb = Math.max(12, track * box.height / state.bodyHeight);
    fillRect(colors.ListHighlight, box.x + box.width + 1, box.y + (track - thumb) * state.bodyScroll / state.bodyMax, 2, thumb);
  }
}

// ---- Frame, scale and input -------------------------------------------

/** One scale for both screens, fitted to the larger (e-mail) window: whole
 * device pixels when enlarging, smooth downscaling on narrow phones. The
 * poster shows only the login window, so it fits that one. */
function fit() {
  const reference = poster ? loginWindow() : computerWindow(ui.screens.email, ui.screens.email.title, []);
  const ratio = window.devicePixelRatio || 1;
  const room = Math.min((innerWidth - 8) / reference.width, (innerHeight - 8) / reference.height);
  const scale = room >= 1 ? Math.floor(room * ratio) / ratio : room;
  document.documentElement.style.setProperty('--scale', scale);
  stage.classList.toggle('smooth', scale < 1);
}
new ResizeObserver(fit).observe(document.documentElement);
fit();

function render() {
  layout = state.screen === 'login' ? loginWindow() : emailWindow();
  for (const button of layout.buttons) {
    const inside = pointer.x >= button.x && pointer.x < button.x + button.width && pointer.y >= button.y && pointer.y < button.y + button.height;
    button.focus = inside;
    button.pressed = inside && pointer.down === button.id;
  }
  if (canvas.width !== layout.width || canvas.height !== layout.height) {
    canvas.width = layout.width; canvas.height = layout.height;
    stage.style.width = `${layout.width}px`; stage.style.height = `${layout.height}px`;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawComputerWindow(layout);
  if (state.screen === 'login') drawLogin(layout); else drawEmail(layout);
  // The DOM inputs sit over the edit boxes so phones get a keyboard.
  for (const edit of EDITS) {
    edit.field.hidden = state.screen !== 'login';
    Object.assign(edit.field.style, {left: `${layout.client.x + edit.x}px`, top: `${layout.client.y + edit.y}px`, width: `${edit.width}px`});
  }
}
function frame() {
  render();
  if (!poster) requestAnimationFrame(frame);
}

// ComputerScreenLogin.ProcessLogin: on failure the info line reports it, both fields clear and the name takes focus.
let checking = false;
async function processLogin() {
  if (checking || !userField.value || !passwordField.value) return;
  checking = true;
  const account = await openAccount(records, userField.value, passwordField.value);
  checking = false;
  if (!account) {
    state.info = ui.labels.invalidLogin;
    userField.value = passwordField.value = '';
    userField.focus();
    return;
  }
  userField.value = passwordField.value = '';
  userField.blur(); passwordField.blur();
  state = {screen: 'email', account, selected: account.emails.length ? 0 : -1, listScroll: 0, bodyScroll: 0};
}
function logout() {
  state = {screen: 'login', info: ui.node.description};
  render(); // unhides the inputs before focusing one
  userField.focus();
}
function cancel() {
  userField.value = passwordField.value = '';
  state.info = ui.node.description;
  userField.focus();
}
function activate(id) {
  ({login: processLogin, cancel, logout})[id]?.();
}

function toLogical(event) {
  const rect = canvas.getBoundingClientRect();
  return {x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height};
}
function buttonAt({x, y}) {
  return layout.buttons.find(b => b.enabled && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
}
canvas.addEventListener('pointermove', event => {
  Object.assign(pointer, toLogical(event));
  canvas.style.cursor = buttonAt(pointer) ? 'pointer' : 'default';
});
canvas.addEventListener('pointerleave', () => Object.assign(pointer, {x: -1, y: -1, down: null}));
canvas.addEventListener('pointerdown', event => {
  Object.assign(pointer, toLogical(event));
  pointer.down = buttonAt(pointer)?.id ?? null;
  if (state.screen === 'email') {
    const c = layout.client, mail = state.account.emails;
    const localX = pointer.x - c.x - LIST.x, localY = pointer.y - c.y - LIST.y + state.listScroll;
    if (localX >= 0 && localX < LIST.width && pointer.y >= c.y + LIST.y && pointer.y < c.y + LIST.y + LIST.height) {
      const row = Math.floor(localY / rowHeight());
      if (row >= 0 && row < mail.length) { state.selected = row; state.bodyScroll = 0; }
    }
  }
});
canvas.addEventListener('pointerup', event => {
  Object.assign(pointer, toLogical(event));
  const button = buttonAt(pointer);
  if (button && button.id === pointer.down) activate(button.id);
  pointer.down = null;
});
canvas.addEventListener('wheel', event => {
  if (state.screen !== 'email') return;
  event.preventDefault();
  state.bodyScroll = Math.min(state.bodyMax ?? 0, Math.max(0, state.bodyScroll + Math.sign(event.deltaY) * fonts[ui.fonts.body].height * 3));
}, {passive: false});
for (const field of [userField, passwordField]) {
  field.addEventListener('input', () => { caretEpoch = performance.now(); });
  field.addEventListener('keydown', event => {
    caretEpoch = performance.now();
    if (event.key === 'Enter') { event.preventDefault(); processLogin(); } // EditActivated
    else if (event.key === 'Escape') cancel();
  });
}
addEventListener('keydown', event => {
  if (state.screen !== 'email') return;
  const mail = state.account.emails;
  if (event.key === 'ArrowDown' && state.selected < mail.length - 1) { state.selected++; state.bodyScroll = 0; }
  else if (event.key === 'ArrowUp' && state.selected > 0) { state.selected--; state.bodyScroll = 0; }
  else if (event.key === 'Escape') logout(); // escapeAction "LOGOUT"
});

if (poster) userField.value = options.get('user') ?? '';
else userField.focus({preventScroll: true});
frame();
