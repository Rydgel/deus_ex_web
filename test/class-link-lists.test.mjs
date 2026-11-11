import test from 'node:test';
import assert from 'node:assert/strict';
import {propertyLinkOf, destructorLinkOf, NEED_CTOR_LINK} from '../src/runtime/class-link-lists.mjs';

// A class that declares no property holds its base's two lists (class-link-lists.mjs); any other class makes its own.

const field = (name, flags = 0) => ({key: `a.b.${name}`, metadata: {flags}});
const link = (propertyOrder, base) => {
  const propertyLink = propertyLinkOf(propertyOrder, base);
  return {propertyOrder, base, propertyLink, destructorLink: destructorLinkOf(propertyLink, propertyOrder, base)};
};
const keys = list => list.map(f => f.key).join(',');

test('a class with no property of its own holds its base\'s lists, a class with some makes its own', () => {
  const [a, b, c] = [field('a'), field('b', NEED_CTOR_LINK), field('c', NEED_CTOR_LINK | 1)];
  const root = link([a, b], null);
  assert.ok(keys(root.propertyLink) === 'a.b.a,a.b.b' && keys(root.destructorLink) === 'a.b.b');
  const plain = link([], root), deeper = link([], plain);
  assert.ok(plain.propertyLink === root.propertyLink && plain.destructorLink === root.destructorLink);
  assert.ok(deeper.propertyLink === root.propertyLink && deeper.destructorLink === root.destructorLink);
  const own = link([c], deeper);
  assert.ok(own.propertyLink !== root.propertyLink && keys(own.propertyLink) === 'a.b.c,a.b.a,a.b.b');
  assert.ok(own.destructorLink !== root.destructorLink && keys(own.destructorLink) === 'a.b.c,a.b.b');
  const below = link([], own);
  assert.ok(below.propertyLink === own.propertyLink && below.destructorLink === own.destructorLink);
  assert.ok(keys(root.propertyLink) === 'a.b.a,a.b.b', 'the base\'s list is as it was');
});

test('a class without a base lists its own properties; a property with no destructor is left out of destructorLink', () => {
  const none = link([], null);
  assert.ok(none.propertyLink.length === 0 && none.destructorLink.length === 0);
  const plain = link([field('p')], null);
  assert.ok(keys(plain.propertyLink) === 'a.b.p' && plain.destructorLink.length === 0);
  const child = link([field('q', NEED_CTOR_LINK)], plain);
  assert.ok(keys(child.propertyLink) === 'a.b.q,a.b.p' && keys(child.destructorLink) === 'a.b.q');
});

test('the same flags the same lists: a shared destructorLink is what the filter makes', () => {
  const root = link([field('a', NEED_CTOR_LINK), field('b'), field('c', NEED_CTOR_LINK)], null);
  const plain = link([], root);
  assert.ok(keys(plain.destructorLink) === keys(plain.propertyLink.filter(f => f.metadata.flags & NEED_CTOR_LINK)));
});

test('a class whose own properties have no destructor holds its base\'s destructorLink; one that has makes its own, own first', () => {
  const root = link([field('a', NEED_CTOR_LINK), field('b')], null);
  const plainOwn = link([field('p'), field('q', 4)], root);
  assert.ok(plainOwn.propertyLink !== root.propertyLink && keys(plainOwn.propertyLink) === 'a.b.p,a.b.q,a.b.a,a.b.b');
  assert.ok(plainOwn.destructorLink === root.destructorLink, 'nothing of its own needs a destructor');
  const withOwn = link([field('r', NEED_CTOR_LINK), field('s')], plainOwn);
  assert.ok(withOwn.destructorLink !== plainOwn.destructorLink && keys(withOwn.destructorLink) === 'a.b.r,a.b.a');
  assert.ok(keys(plainOwn.destructorLink) === 'a.b.a', 'the base\'s list is as it was');
  const below = link([field('t')], withOwn);
  assert.ok(below.destructorLink === withOwn.destructorLink);
  // the list is always the filter of the property list, whichever way it was made
  for (const c of [root, plainOwn, withOwn, below])
    assert.ok(keys(c.destructorLink) === keys(c.propertyLink.filter(f => f.metadata.flags & NEED_CTOR_LINK)));
});
