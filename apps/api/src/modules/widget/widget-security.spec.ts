import { isOriginAllowed, normalizeDomain, widgetSettingsSchema } from '@orderos/shared';

/**
 * The widget key is public — it ships in the restaurant's page source. The ONLY
 * thing stopping a scraped key from being used on another website is the pair of
 * functions tested here. A bug in either one means anybody can run someone else's
 * ordering widget, so these get tested properly.
 */

describe('normalizeDomain', () => {
  it('accepts a bare domain', () => {
    expect(normalizeDomain('joesburgers.com')).toBe('joesburgers.com');
  });

  it('tolerates what an owner will actually paste', () => {
    // Every one of these is something a restaurant owner will type into the box.
    expect(normalizeDomain('https://joesburgers.com')).toBe('joesburgers.com');
    expect(normalizeDomain('https://www.joesburgers.com/order?utm=x')).toBe('joesburgers.com');
    expect(normalizeDomain('  JoesBurgers.COM  ')).toBe('joesburgers.com');
    expect(normalizeDomain('joesburgers.com/menu')).toBe('joesburgers.com');
    expect(normalizeDomain('joesburgers.com:443')).toBe('joesburgers.com');
  });

  it('strips www so joes.com and www.joes.com are one domain', () => {
    expect(normalizeDomain('www.joesburgers.com')).toBe('joesburgers.com');
  });

  it('keeps a genuine subdomain', () => {
    expect(normalizeDomain('order.joesburgers.com')).toBe('order.joesburgers.com');
    expect(normalizeDomain('joes.wixsite.com')).toBe('joes.wixsite.com');
  });

  it('allows localhost, so a developer can test before going live', () => {
    expect(normalizeDomain('localhost')).toBe('localhost');
    expect(normalizeDomain('http://localhost:8080')).toBe('localhost');
  });

  it('rejects junk rather than storing a domain that can never match', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('joes burgers.com')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['joesburgers.com', 'order.joesburgers.com'];

  it('allows a registered domain, with or without www', () => {
    expect(isOriginAllowed('https://joesburgers.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://www.joesburgers.com', allowed)).toBe(true);
    // The port is part of the Origin but not of the host we match on.
    expect(isOriginAllowed('http://joesburgers.com:3000', allowed)).toBe(true);
  });

  it('allows an explicitly registered subdomain', () => {
    expect(isOriginAllowed('https://order.joesburgers.com', allowed)).toBe(true);
  });

  it('REFUSES an unregistered subdomain', () => {
    // This is the important one. On shared hosts — wordpress.com, wixsite.com,
    // squarespace.com — a sibling subdomain belongs to a completely different
    // business. Treating `joes.com` as authorising `*.joes.com` would let any
    // WordPress.com user embed any other WordPress.com restaurant's widget.
    expect(isOriginAllowed('https://evil.joesburgers.com', allowed)).toBe(false);
  });

  it('refuses a lookalike domain', () => {
    expect(isOriginAllowed('https://joesburgers.com.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://notjoesburgers.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://joesburgers.co', allowed)).toBe(false);
  });

  it('refuses a stolen key pasted onto another site', () => {
    // The whole threat model, in one assertion.
    expect(isOriginAllowed('https://someoneelse.com', allowed)).toBe(false);
  });

  it('refuses a malformed or absent origin', () => {
    expect(isOriginAllowed('', allowed)).toBe(false);
    expect(isOriginAllowed('null', allowed)).toBe(false);
    expect(isOriginAllowed('not-a-url', allowed)).toBe(false);
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(isOriginAllowed('https://joesburgers.com', [])).toBe(false);
  });
});

describe('widgetSettingsSchema', () => {
  it('fills in a complete, usable default from an empty object', () => {
    // The loader renders straight from this, so a partial default would mean a
    // widget with no button text or an undefined colour.
    const settings = widgetSettingsSchema.parse({});
    expect(settings.mode).toBe('FLOATING_BUTTON');
    expect(settings.buttonText).toBe('Order Now');
    expect(settings.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('rejects a colour that would be injected raw into a style attribute', () => {
    // The loader interpolates these into CSS. A non-hex value here is a CSS
    // injection into the restaurant's page, so the schema is the boundary.
    expect(() => widgetSettingsSchema.parse({ primaryColor: 'red; } body { display:none' })).toThrow();
    expect(() => widgetSettingsSchema.parse({ primaryColor: 'javascript:alert(1)' })).toThrow();
    expect(() => widgetSettingsSchema.parse({ primaryColor: '#GGGGGG' })).toThrow();
  });

  it('caps button text so it cannot become a paragraph on someone else s site', () => {
    expect(() => widgetSettingsSchema.parse({ buttonText: 'x'.repeat(50) })).toThrow();
  });

  it('refuses a font stack that would break out of its CSS rule', () => {
    // fontFamily is interpolated into a CSS declaration in the loader, so it is
    // an injection point into the RESTAURANT'S OWN homepage. A compromised
    // dashboard account must not be able to deface the live site through it.
    expect(() =>
      widgetSettingsSchema.parse({ fontFamily: 'Arial; } body { display: none } .x {' }),
    ).toThrow();
    expect(() =>
      widgetSettingsSchema.parse({ fontFamily: 'Arial; background: url(https://evil.com)' }),
    ).toThrow();

    // Real font stacks must still pass, including the default.
    expect(
      widgetSettingsSchema.parse({ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' })
        .fontFamily,
    ).toContain('system-ui');
    expect(widgetSettingsSchema.parse({ fontFamily: 'inherit' }).fontFamily).toBe('inherit');
  });
});
