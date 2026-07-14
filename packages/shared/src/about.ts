/**
 * The About page's content model. All of it.
 *
 * A restaurant writes plain text. Blank lines separate paragraphs. There is no
 * markdown, no HTML, no rich text editor, and no layout control.
 *
 * That is a decision, not a shortcut:
 *
 *  - A tenant who can store HTML that we inject into a page served on
 *    *.dinedirect.manvion.ca has stored XSS. Their page shares an origin with our cookies and,
 *    on a custom domain, with their customers' sessions. "Just sanitise it" is a
 *    permanent commitment to being better at sanitising than the entire internet is
 *    at bypassing sanitisers, and that is a bet nobody wins forever.
 *
 *  - Layout freedom is how conversion dies. Every storefront here is arranged to get
 *    one person from a phone to a paid order. An owner who can put a hero carousel
 *    above the menu will, and the drop is real. If they want a marketing website,
 *    they should keep the one they have and put our widget on it.
 *
 * So the model is: a headline, some paragraphs, and photos. It is enough for "we
 * opened in 1998 and we still grind the beef ourselves", which is what an About page
 * is actually for.
 */

/** Longest a single paragraph can get before it stops being read. Not enforced — advisory. */
export const ABOUT_BODY_MAX = 4000;
export const ABOUT_HEADLINE_MAX = 120;
export const GALLERY_MAX_IMAGES = 12;

/**
 * Split an About body into paragraphs for rendering.
 *
 * The output is an array of STRINGS, which callers render as text nodes — never as
 * HTML. Returning strings rather than markup is the point: there is no way to use
 * this function that injects anything.
 */
export function aboutParagraphs(body: string | null | undefined): string[] {
  if (!body) return [];

  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    // Collapse single newlines inside a paragraph into spaces: someone pasting from
    // Word gets hard-wrapped lines, and rendering those as-is looks broken.
    .map((p) => p.replace(/\s*\n\s*/g, ' '))
    .filter(Boolean);
}

export interface GalleryImage {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number;
}

/** Does this restaurant have an About page worth linking to? */
export function hasAboutContent(input: {
  aboutHeadline?: string | null;
  aboutBody?: string | null;
  description?: string | null;
  galleryImages?: GalleryImage[];
}): boolean {
  return Boolean(
    input.aboutHeadline?.trim() ||
      input.aboutBody?.trim() ||
      input.description?.trim() ||
      input.galleryImages?.length,
  );
}
