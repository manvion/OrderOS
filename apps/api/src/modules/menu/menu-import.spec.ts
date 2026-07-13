import { parsePriceToCents } from './menu-import.service';

/**
 * Prices off a photographed menu, into cents. This is money math fed by OCR-ish
 * output, so the tests are about the ways real menus write numbers — not about
 * exercising the happy path twice.
 */
describe('parsePriceToCents', () => {
  it('reads the ordinary US shape', () => {
    expect(parsePriceToCents('12.99')).toBe(1299);
    expect(parsePriceToCents('5')).toBe(500);
    expect(parsePriceToCents('0.99')).toBe(99);
  });

  it('reads the European decimal comma', () => {
    // "12,50" is twelve-and-a-half in Berlin, not twelve hundred and fifty.
    expect(parsePriceToCents('12,50')).toBe(1250);
  });

  it('reads thousands separators in both conventions', () => {
    expect(parsePriceToCents('1,299.00')).toBe(129900);
    expect(parsePriceToCents('1.299,00')).toBe(129900);
    // A lone separator followed by exactly three digits is a thousands mark:
    // "1.299" is an Indian thali platter at ₹1299, not $1.29.
    expect(parsePriceToCents('1.299')).toBe(129900);
    expect(parsePriceToCents('1,299')).toBe(129900);
  });

  it('strips currency symbols and whitespace the model left in despite instructions', () => {
    expect(parsePriceToCents('$12.99')).toBe(1299);
    expect(parsePriceToCents('₹250')).toBe(25000);
    expect(parsePriceToCents(' 8.00 ')).toBe(800);
  });

  it('returns null for the unreadable, rather than guessing', () => {
    // Null forces the review form to make the owner type the price. A guess here
    // becomes a $0 item a customer can order for free.
    expect(parsePriceToCents('')).toBeNull();
    expect(parsePriceToCents('market price')).toBeNull();
    expect(parsePriceToCents('—')).toBeNull();
  });

  it('rejects prices that are misreads, not prices', () => {
    expect(parsePriceToCents('0')).toBeNull();
    expect(parsePriceToCents('0.00')).toBeNull();
    // Six figures for a menu item is a smudge on the lens.
    expect(parsePriceToCents('99999.00')).toBeNull();
  });
});
