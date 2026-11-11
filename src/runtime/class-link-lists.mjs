/**
 * A linked class's property lists (docs/firefox-60fps-plan.md, "The linked classes' defaults and property links").
 *
 * `propertyLink` is the class's own properties followed by its base's list, and `destructorLink` the members of it that have a
 * destructor (CPF_NeedCtorLink, 0x00400000). A class that declares no property (455 of the 967 the Island links: the pawn and decoration
 * subclasses that differ in their defaults and their script) lists exactly its base's, so it holds its base's arrays: one array a
 * chain of such classes instead of a copy each (227 entries a class). Nothing changes a link array: a class's lists are made here once, at
 * its link, and read as lists (the layouts compare them by their members; viewport-console shares the player's two the same way).
 */
export const NEED_CTOR_LINK = 0x00400000;

// FREEZE_LINKS=on (Node's environment; a browser realm has none): the lists are frozen, so a writer throws, and a destructorLink a class
// shares with its base is checked against the filter it replaces. The validators and the digests run with it to show nothing writes a list.
const CHECKED = typeof process !== 'undefined' && process.env?.FREEZE_LINKS === 'on';
const made = list => CHECKED ? Object.freeze(list) : list;

/** `[...propertyOrder, ...base.propertyLink]`, the base's own array when the class declares none. */
export function propertyLinkOf(propertyOrder, base) {
  const inherited = base?.propertyLink;
  if (propertyOrder.length === 0 && inherited) return inherited;
  return made([...propertyOrder, ...(inherited ?? [])]);
}

/**
 * The members of `propertyLink` with a destructor: the class's own, then the base's `destructorLink` (the filter of `[...own, ...base's
 * list]` is the filter of each part), and the base's array itself when no property of the class has one (the class declares none, or
 * none needs a destructor: 512 of the Island's lists were 221 different ones).
 */
export function destructorLinkOf(propertyLink, propertyOrder, base) {
  const inherited = base?.destructorLink;
  const needs = field => field.metadata.flags & NEED_CTOR_LINK;
  let result;
  if (inherited === undefined) result = propertyLink.filter(needs);
  else {
    let own = null;
    for (const field of propertyOrder) if (needs(field)) (own ??= []).push(field);
    result = own === null ? inherited : [...own, ...inherited];
  }
  if (CHECKED && inherited !== undefined) {
    const expected = propertyLink.filter(needs);
    if (expected.length !== result.length || expected.some((field, index) => field !== result[index]))
      throw new Error('A class\'s destructorLink is not the filter of its propertyLink');
  }
  return result === inherited ? result : made(result);
}
