import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD, cardTags, pageCard, publishedAt } from '../scripts/vite-page-card.mjs';

// The public page's link preview (docs/development.md "The public page", scripts/vite-page-card.mjs).

test('a build without a published address carries no card', () => {
  assert.equal(publishedAt(undefined), null);
  assert.equal(publishedAt(''), null);
  const plugin = pageCard({ site: undefined });
  assert.deepEqual(plugin.transformIndexHtml(), []);
});

test('the published address is a plain https address, kept without its trailing slash', () => {
  assert.equal(publishedAt('https://rydgel.github.io/deus_ex_web'), 'https://rydgel.github.io/deus_ex_web');
  assert.equal(publishedAt('https://rydgel.github.io/deus_ex_web/'), 'https://rydgel.github.io/deus_ex_web');
  assert.equal(publishedAt('https://example.test'), 'https://example.test');
  for (const wrong of ['http://example.test', 'example.test/page', 'https://example.test/?x=1', 'https://example.test/#a']) {
    assert.throws(() => publishedAt(wrong), /DX_PUBLIC_URL/);
  }
});

test('every address in the card is absolute, under the published address', () => {
  const tags = cardTags('https://example.test/game', 'assets/card-0123abcd.jpg');
  const value = key => tags.find(tag => tag.attrs.property === key || tag.attrs.name === key)?.attrs.content;
  assert.equal(value('og:url'), 'https://example.test/game/');
  assert.equal(value('og:image'), 'https://example.test/game/assets/card-0123abcd.jpg');
  assert.equal(value('twitter:image'), value('og:image'));
  assert.equal(value('twitter:card'), 'summary_large_image');
  assert.equal(value('og:title'), CARD.title);
  assert.equal(value('twitter:description'), CARD.description);
  assert.deepEqual([value('og:image:width'), value('og:image:height')], ['1280', '640']);
  assert.equal(tags.find(tag => tag.tag === 'link').attrs.href, 'https://example.test/game/');
  assert.ok(tags.every(tag => tag.injectTo === 'head'));
});

test('the plugin puts the image in assets under a name made from its bytes, then writes the tags', async () => {
  const emitted = [];
  const plugin = pageCard({ site: 'https://example.test/game/' });
  await plugin.buildStart.call({ emitFile: file => emitted.push(file) });
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].fileName, /^assets\/card-[0-9a-f]{8}\.jpg$/);
  assert.ok(emitted[0].source.length > 20_000);
  const image = plugin.transformIndexHtml().find(tag => tag.attrs.property === 'og:image').attrs.content;
  assert.equal(image, `https://example.test/game/${emitted[0].fileName}`);
});
