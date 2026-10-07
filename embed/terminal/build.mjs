/**
 * X player-card page: a UNATCO network terminal, drawn with the original
 * ComputerScreenLogin / ComputerScreenEmail windows (a fan puzzle game).
 *
 * Reads the installed game through the project's package readers and writes
 * embed/terminal/out/ (ignored by Git: it holds original assets).
 * See embed/terminal/README.md.
 *
 *   node embed/terminal/build.mjs [--url https://host/path/] [--poster]
 */
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {baseUrlOption, gameAssets, png} from '../shared.mjs';
import {ClassDefaults, readClass} from '../../src/unreal/classes.mjs';
import {objectAt, readObject} from '../../src/unreal/objects.mjs';
import {TextureStore} from '../../src/unreal/textures.mjs';
import {decodeFontExport} from '../../src/runtime/script-font-model.mjs';
import {encryptStory} from './story-crypto.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const args = process.argv.slice(2);
const baseUrl = baseUrlOption(args);

const {game, assets} = await gameAssets();
const textures = new TextureStore(assets), classes = new ClassDefaults(assets);
const dx = await assets.get('DeusEx'), ui = await assets.get('DeusExUI');

await rm(out, {recursive: true, force: true});
await mkdir(path.join(out, 'assets'), {recursive: true});

const classIndex = name => {
  const index = dx.pkg.exports.findIndex(e => e.path === name && e.className === 'Class') + 1;
  if (!index) throw new Error(`DeusEx has no class ${name}`);
  return index;
};
/** Scalar defaults, inherited (ClassDefaults leaves object references out). */
const defaults = name => classes.get(dx, classIndex(name));
/** An object default, inherited, resolved to its package. */
async function objectDefault(className, property) {
  const found = await classes.objectDefault(dx, classIndex(className), property);
  if (!found) throw new Error(`${className}.${property} has no default`);
  return assets.resolve(found.asset, found.ref);
}
/** A class's own object-array default (clientTextures[0..n]). */
async function objectArray(className, property) {
  const values = readClass(dx, classIndex(className)).properties.filter(p => p.name === property && p.value);
  return Promise.all(values.sort((a, b) => a.arrayIndex - b.arrayIndex).map(p => assets.resolve(dx, p.value)));
}
/** S_MenuUIBorderButtonTextures {Texture tex; int width} defaults: [normal, pressed]. */
async function buttonTextures(className, property) {
  const values = readClass(dx, classIndex(className)).properties.filter(p => p.name === property);
  return Promise.all(values.sort((a, b) => a.arrayIndex - b.arrayIndex).map(async p => {
    const r = {bytes: p.data, at: 0};
    let byte = r.bytes[r.at++], ref = byte & 0x3f, shift = 6;
    if (byte & 0x40) do { byte = r.bytes[r.at++]; ref |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    if (r.bytes[0] & 0x80) ref = -ref;
    const width = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.at, 4).getInt32(0, true);
    return {texture: await texture(await assets.resolve(dx, ref)), width};
  }));
}

/** Masked upload (D3D PF_Masked): palette index 0 is transparent black. */
const written = new Map();
async function texture(object) {
  if (!written.has(object.key)) {
    const pending = (async () => {
      const t = await textures.get(object.asset, object.index, true), mip = t.mips[0];
      const file = `${object.key.split('.').pop()}.png`;
      await writeFile(path.join(out, 'assets', file), png(mip.width, mip.height, mip.data));
      return {file, width: mip.width, height: mip.height};
    })();
    written.set(object.key, pending);
  }
  return written.get(object.key);
}
const textureNamed = async (className, property) => texture(await objectDefault(className, property));

/** UFont: page textures plus one [U, V, USize, VSize] rectangle per character. */
const fonts = {};
async function font(object) {
  const name = object.key.split('.').pop();
  if (fonts[name]) return name;
  const {entry} = object, bytes = object.asset.bytes;
  const decoded = decodeFontExport(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize), object.key);
  const r = readObject(object.asset.pkg, bytes, object.index).reader;
  if (r.compact() !== decoded.pageCount) throw new Error(`${object.key}: page count mismatch`);
  const pages = [];
  for (let p = 0; p < decoded.pageCount; p++) {
    const ref = r.compact(), count = r.compact();
    r.take(count * 16);
    pages.push({texture: await texture(await assets.resolve(object.asset, ref)), glyphs: decoded.pages[p].chars});
  }
  fonts[name] = {pages, charsPerPage: decoded.charsPerPage};
  return name;
}
const fontNamed = async (className, property) => font(await objectDefault(className, property));

// ColorThemeMenu_Default, by ColorThemeMenu's colour names.
const theme = await defaults('ColorThemeMenu_Default'), colors = {};
for (let i = 0; theme[i ? `colorNames[${i}]` : 'colorNames']; i++) {
  colors[theme[i ? `colorNames[${i}]` : 'colorNames'].replace('MenuColor_', '')] = theme[i ? `Colors[${i}]` : 'Colors'].slice(0, 3);
}

// Computers.NodeInfo[0] is localized: DeusEx.int holds its text.
const localized = (await readFile(path.join(game, 'System', 'DeusEx.int'), 'latin1')).replaceAll('\r', '');
const nodeLine = localized.match(/^NodeInfo\[0\]="\((.*)\)"$/m)?.[1];
if (!nodeLine) throw new Error('DeusEx.int has no Computers NodeInfo[0]');
const nodeField = name => nodeLine.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
const nodeTexture = nodeLine.match(/nodeTexture=Texture'DeusExUI\.([^']+)'/)[1];
const node = {name: nodeField('nodeName'), description: nodeField('nodeDesc'), address: nodeField('nodeAddress'),
  logo: await texture(await assets.resolve(ui, ui.exportsByPath.get(nodeTexture.toLowerCase())))};

const computer = await defaults('ComputerUIWindow');
const screen = async name => {
  const v = await defaults(name);
  return {title: v.Title, clientWidth: v.ClientWidth, clientHeight: v.ClientHeight, statusPosY: v.statusPosY,
    statusLeftOffset: v.defaultStatusLeftOffset, statusHeight: v.defaultStatusHeight, statusClientDiffY: v.defaultStatusClientDiffY,
    functionLabel: v.ComputerNodeFunctionLabel, textureCols: v.textureCols, textureRows: v.textureRows,
    clientTextures: await Promise.all((await objectArray(name, 'clientTextures')).map(texture))};
};
const titleWindow = await defaults('MenuUITitleWindow');
const button = async name => {
  const v = await defaults(name);
  return {height: v.buttonHeight, minimumWidth: v.minimumButtonWidth ?? 0, textLeftMargin: v.textLeftMargin,
    verticalTextMargin: v.verticalTextMargin, useTextOffset: v.bUseTextOffset !== false, font: await fontNamed(name, 'fontButtonText'),
    left: await buttonTextures(name, 'Left_Textures'), center: await buttonTextures(name, 'Center_Textures'),
    right: await buttonTextures(name, 'Right_Textures')};
};
const buttonBar = await defaults('MenuUIActionButtonBarWindow');
const login = await defaults('ComputerScreenLogin'), email = await defaults('ComputerScreenEmail');
const label = n => n.replace('|&', '');

const layout = {
  source: 'DeusEx.u class defaults and script constants, DeusExUI.u textures and fonts, DeusEx.int',
  colors, node,
  status: `Daedalus:GlobalNode:${node.address}/`,
  title: {height: titleWindow.titleHeight, minimumWidth: titleWindow.minTitleWidth, leftMargin: titleWindow.titleLeftMargin,
    rightMargin: titleWindow.titleRightMargin, leftWidth: titleWindow.leftWidth, rightWidth: titleWindow.rightWidth,
    leftBottomWidth: titleWindow.leftBottomWidth, leftBottomHeight: titleWindow.leftBottomHeight,
    font: await fontNamed('MenuUITitleWindow', 'fontTitle'), icon: await textureNamed('MenuUITitleWindow', 'textureAppIcon'),
    textures: Object.fromEntries(await Promise.all(['titleTexture_Left', 'titleTexture_Center', 'titleTexture_Right',
      'titleTexture_LeftBottom', 'titleBubble_Left', 'titleBubble_Center', 'titleBubble_Right']
      .map(async p => [p, await textureNamed('MenuUITitleWindow', p)])))},
  buttons: {action: await button('MenuUIActionButtonWindow'), info: await button('MenuUIInfoButtonWindow'),
    header: await button('MenuUIListHeaderButtonWindow'), barHeight: buttonBar.defaultBarHeight, spacing: buttonBar.buttonSpacing},
  fonts: {label: await fontNamed('MenuUILabelWindow', 'fontLabel'), small: await fontNamed('MenuUISmallLabelWindow', 'fontLabel'),
    edit: await fontNamed('MenuUIEditWindow', 'fontText'), help: await fontNamed('MenuUIHelpWindow', 'fontText'),
    list: await fontNamed('MenuUIListWindow', 'fontText'), body: await fontNamed('MenuUINormalLargeTextWindow', 'fontLabel')},
  labels: {login: label(computer.ButtonLabelLogin), logout: label(computer.ButtonLabelLogout), cancel: label(computer.ButtonLabelCancel),
    userName: login.UserNameLabel, password: login.PasswordLabel, invalidLogin: login.InvalidLoginMessage,
    noEmail: email.NoEmailTodayText, from: email.EmailFromHeader, to: email.EmailToHeader, cc: email.EmailCarbonCopyHeader,
    subject: email.EmailSubjectHeader, headerFrom: email.HeaderFromLabel, headerSubject: email.HeaderSubjectLabel},
  screens: {login: await screen('ComputerScreenLogin'), email: await screen('ComputerScreenEmail')},
  fontData: fonts,
};
await writeFile(path.join(out, 'assets', 'ui.json'), JSON.stringify(layout));

// The story: e-mails sealed per account with a key derived from its password.
const story = await import(path.join(here, 'story.mjs'));
await writeFile(path.join(out, 'assets', 'accounts.json'), JSON.stringify(await encryptStory(story.accounts)));

for (const file of ['main.js', 'style.css']) await cp(path.join(here, 'page', file), path.join(out, file));
await cp(path.join(here, 'story-crypto.mjs'), path.join(out, 'story-crypto.js'));
const absolute = file => (baseUrl ?? '') + file;
await writeFile(path.join(out, 'index.html'), (await readFile(path.join(here, 'page', 'index.html'), 'utf8'))
  .replaceAll('%PLAYER_URL%', absolute(''))
  .replaceAll('%IMAGE_URL%', absolute('card.png'))
  .replaceAll('%PAGE_URL%', absolute('')));
await writeFile(path.join(out, '_headers'), '/*\n  Content-Security-Policy: frame-ancestors \'self\' https://x.com https://*.x.com https://twitter.com https://*.twitter.com\n');

if (args.includes('--poster') || baseUrl) {
  const {renderPoster} = await import('../poster.mjs');
  // The teaser: JC's user name already typed, the password left to the reader.
  await renderPoster(path.join(out, 'card.png'), {root: out, query: '?poster&user=JCD'});
}
console.log(`embed/terminal/out written (${written.size} textures, ${Object.keys(fonts).length} fonts, ${story.accounts.length} accounts).`);
if (!baseUrl) console.log('No --url given: card meta tags hold relative URLs, which X ignores. Rebuild with --url before deploying.');
