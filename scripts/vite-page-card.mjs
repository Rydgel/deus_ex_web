/** The public page's link preview (docs/development.md "The public page"): the tags X, Discord, Slack and others read to draw a
 * card for a shared link, and the card's image in the build.
 *
 * A card needs absolute addresses, which only the place a build is published at can give. So the tags exist only in a build made
 * with DX_PUBLIC_URL, the address the page will be served from (the Pages workflow passes it). Any other build, a local one or a
 * fork's, carries no card and claims no address. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const CARD = Object.freeze({
  title: 'Deus Ex (2000), in a browser tab',
  description: 'The original game on an independent, reimplemented engine, checked bit for bit against the original. '
    + 'Bring your own copy of the game: nothing is uploaded.',
  alt: 'Liberty Island at night in Deus Ex, with the original HUD, running in a browser window.',
  width: 1280, height: 640,
});

/** The published address without its trailing slash, or null when none is given. Anything but an https address is an error:
 * a build with a wrong address would publish a card that points nowhere. */
export function publishedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  let url; try { url = new URL(value); } catch { throw new Error(`DX_PUBLIC_URL is not an address: ${value}`); }
  if (url.protocol !== 'https:' || url.search || url.hash) throw new Error(`DX_PUBLIC_URL must be a plain https address: ${value}`);
  return url.href.replace(/\/+$/, '');
}

/** The head tags of a page published at `site` (no trailing slash) whose card image is the build's file `image`. */
export function cardTags(site, image) {
  const meta = attrs => ({ tag: 'meta', attrs, injectTo: 'head' });
  const picture = `${site}/${image}`;
  return [
    { tag: 'link', attrs: { rel: 'canonical', href: `${site}/` }, injectTo: 'head' },
    meta({ property: 'og:type', content: 'website' }),
    meta({ property: 'og:url', content: `${site}/` }),
    meta({ property: 'og:title', content: CARD.title }),
    meta({ property: 'og:description', content: CARD.description }),
    meta({ property: 'og:image', content: picture }),
    meta({ property: 'og:image:width', content: String(CARD.width) }),
    meta({ property: 'og:image:height', content: String(CARD.height) }),
    meta({ property: 'og:image:alt', content: CARD.alt }),
    meta({ name: 'twitter:card', content: 'summary_large_image' }),
    meta({ name: 'twitter:title', content: CARD.title }),
    meta({ name: 'twitter:description', content: CARD.description }),
    meta({ name: 'twitter:image', content: picture }),
    meta({ name: 'twitter:image:alt', content: CARD.alt }),
  ];
}

/** The Vite plugin: in a build with a published address, the card image goes into `assets/` under a name made from its bytes
 * (a changed image gets a new address, so no service shows a stale one) and the tags go into the page's head. */
export function pageCard({ site = process.env.DX_PUBLIC_URL, image = new URL('../docs/readme/card.jpg', import.meta.url) } = {}) {
  const root = publishedAt(site);
  let fileName = null;
  return {
    name: 'public-page-card',
    apply: 'build',
    async buildStart() {
      if (!root) return;
      const source = await readFile(image);
      fileName = `assets/card-${createHash('sha256').update(source).digest('hex').slice(0, 8)}.jpg`;
      this.emitFile({ type: 'asset', fileName, source });
    },
    transformIndexHtml() {
      if (!root) return [];
      if (!fileName) throw new Error('The card image was not read before the page was written');
      return cardTags(root, fileName);
    },
  };
}
