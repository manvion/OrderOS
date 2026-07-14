import { randomBytes } from 'node:crypto';
import { HANDOFF_CODE_LENGTH, generateHandoffCode, isUnambiguous } from '@dinedirect/shared';

const gen = () => generateHandoffCode((n) => randomBytes(n));

/**
 * The code that decides whether the right food reaches the right person.
 *
 * The property under test is not randomness — it is READABILITY UNDER PRESSURE. This
 * gets read off a phone screen in a loud kitchen by someone who may not be a native
 * speaker, and matched against a sticker on a bag. A "0" that could be an "O" is not
 * a theoretical collision here; it is a wrong bag handed to a courier, food that is
 * gone, two furious customers, and neither order remakeable for free.
 */
describe('handoff codes', () => {
  it('is four characters', () => {
    expect(gen()).toHaveLength(HANDOFF_CODE_LENGTH);
  });

  it('never contains a glyph a human could misread', () => {
    // O/0, I/1/L, S/5 are all excluded. Check a large sample, because this failing
    // even 1% of the time means 1% of bags are ambiguous.
    for (let i = 0; i < 5_000; i++) {
      const code = gen();
      expect(code).not.toMatch(/[O0I1LS5]/);
      expect(isUnambiguous(code)).toBe(true);
    }
  });

  it('is uppercase alphanumeric only — it gets typed on a greasy tablet', () => {
    for (let i = 0; i < 1_000; i++) {
      expect(gen()).toMatch(/^[A-Z2-9]{4}$/);
    }
  });

  it('does not collide often enough to matter on a pass', () => {
    // It does NOT need to be unguessable. It needs to be un-confusable between the
    // two or three bags physically sitting on the pass right now. Across 2,000 codes
    // we should see very few duplicates.
    const codes = new Set<string>();
    for (let i = 0; i < 2_000; i++) codes.add(gen());

    // ~810,000 possible codes; 2,000 draws should collide rarely.
    expect(codes.size).toBeGreaterThan(1_990);
  });
});
