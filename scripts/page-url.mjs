/** The page starts as the original does unless the URL asks for the debugging page (docs/boot.md "The page"): `debug=1` brings back the
 * toolbar, Inspect, the map list and the first-map default every tool and validator was written against. Every script that opens the page
 * opens it through this. */
export function debugUrl(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('debug')) parsed.searchParams.set('debug', '1');
  return parsed.href;
}
