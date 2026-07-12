/**
 * The code that gets the right food to the right person.
 *
 * Every order has one, whatever the fulfillment:
 *
 *   PICKUP    — the customer reads it out at the counter. "Order for John" fails
 *               when there are two Johns; "K7M2" does not.
 *   DINE_IN   — printed on the ticket next to the table number, so a runner
 *               carrying three plates knows which table each belongs to.
 *   DELIVERY  — the courier reads it off their phone and staff match it to the bag.
 *               This is the single most expensive operational failure in delivery:
 *               hand the wrong bag to the wrong driver and the food is gone, both
 *               customers are furious, and neither order can be remade for free.
 *
 * Deliberately NOT the order number. Order numbers are sequential and two orders
 * placed in the same minute look almost identical on a bag label — 0712-014 vs
 * 0712-041. This is read off a phone screen, in a loud kitchen, by someone who may
 * not be a native speaker, and then matched against a sticker on a bag.
 *
 * The alphabet has every ambiguous glyph removed: no O/0, no I/1/L, no S/5. "0" vs
 * "O" is not a theoretical collision here. It's Tuesday.
 *
 * ~29^4 ≈ 707,000 combinations. It does not need to be unguessable — it needs to be
 * un-confusable between the two or three bags physically on the pass right now.
 */
const CODE_ALPHABET = '2346789ABCDEFGHJKMNPQRTUVWXYZ';

export const HANDOFF_CODE_LENGTH = 4;

/**
 * `randomBytes` is injected so this stays pure and testable, and so the browser can
 * import the module without pulling in node:crypto.
 */
export function generateHandoffCode(randomBytes: (n: number) => Uint8Array): string {
  return Array.from(randomBytes(HANDOFF_CODE_LENGTH))
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
}

/** Would a human confuse these two codes at a glance? Used only in tests. */
export function isUnambiguous(code: string): boolean {
  return code.split('').every((c) => CODE_ALPHABET.includes(c));
}
