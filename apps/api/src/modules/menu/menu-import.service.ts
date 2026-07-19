import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

/**
 * A menu photo -> a structured menu, ready to review and import.
 *
 * Typing a menu into a form is the single most tedious step of onboarding — a
 * 60-item menu is an hour of data entry, and it lands exactly where a restaurant
 * owner's patience is thinnest: before they've made a single sale on the platform.
 * Every abandoned onboarding is a restaurant that wanted the product and gave up.
 * So instead: photograph the physical menu they already have, and a vision model
 * reads it.
 *
 * The extraction is a DRAFT, never a write. Vision models misread grease-stained
 * laminate and hand-chalked specials, and a wrong price on a live menu is money
 * lost on every order until someone notices. The owner reviews the draft — every
 * name, every price — edits inline, and only what they approve is created, through
 * the same validated endpoints manual entry uses. The AI does the typing; the
 * human stays accountable for the menu.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * What Claude must return. Enforced by structured outputs — the API guarantees the
 * response parses against this schema, so there is no "the model wrapped it in
 * markdown" failure mode to defend against.
 *
 * Prices are decimal strings ("12.99"), not cents. Menus print decimals; asking the
 * model to multiply by 100 invites off-by-100 errors, so the arithmetic happens here,
 * in code, where it can't hallucinate.
 */
const extractedMenuSchema = z.object({
  categories: z.array(
    z.object({
      name: z.string(),
      items: z.array(
        z.object({
          name: z.string(),
          /** Empty string when the menu has no description — never invented. */
          description: z.string(),
          /** Decimal string as printed, e.g. "12.99". Empty when unreadable. */
          price: z.string(),
        }),
      ),
    }),
  ),
  /** Anything the model could not read confidently — shown to the owner as a checklist. */
  warnings: z.array(z.string()),
});

/** fetch() errors don't carry HTTP status; this one does, for the ladder's 4xx check. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MenuImportDraft {
  categories: Array<{
    name: string;
    items: Array<{
      name: string;
      description: string | null;
      /** Null when the price was unreadable — the form forces the owner to fill it. */
      priceCents: number | null;
    }>;
  }>;
  warnings: string[];
}

@Injectable()
export class MenuImportService {
  private readonly logger = new Logger(MenuImportService.name);
  private readonly openRouterKey: string | undefined;
  private readonly openRouterModels: string[];

  constructor(config: ConfigService) {
    /**
     * Free vision-capable models read menus well enough that a human review
     * catches the rest -- and the review step was already mandatory. The
     * default ladder below was taken from OpenRouter's live catalog on the
     * day this shipped; the catalog churns, so the list is an env override
     * away from current.
     */
    this.openRouterKey = config.get<string>('OPENROUTER_API_KEY');
    this.openRouterModels = (
      config.get<string>('OPENROUTER_MODELS') ??
      'google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-nano-12b-v2-vl:free'
    )
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  // With no key configured the dashboard hides the button. Menu entry still
  // works by hand; this is an accelerant, not a dependency.
  get available(): boolean {
    return Boolean(this.openRouterKey);
  }

  /**
   * Read one menu photo into a draft.
   *
   * `currency` is the restaurant's, passed so the model knows how to read the
   * numbers: "12,50" is twelve-and-a-half in Berlin and a typo in Boston, and
   * an Indian menu's "₹250" must not come back as 2.50.
   */
  async extractFromPhoto(
    file: { buffer: Buffer; mimetype: string },
    currency: string,
  ): Promise<MenuImportDraft> {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'Menu import is not configured on this server. You can still add menu items manually.',
      );
    }

    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported image type "${file.mimetype}". Use a JPEG, PNG or WebP photo.`,
      );
    }
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new BadRequestException('Image exceeds the 10MB limit — a phone photo is plenty.');
    }
    if (file.buffer.byteLength === 0) {
      throw new BadRequestException('The image is empty');
    }

    const extracted = await this.runExtraction(currency, {
      prompt: 'Transcribe this menu. Every legible item, exactly as printed.',
      image: {
        mediaType: file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp',
        base64: file.buffer.toString('base64'),
      },
    });

    return this.toDraft(extracted);
  }

  /** Shared tail of every ingestion path: validated extraction -> reviewed draft. */
  private toDraft(extracted: z.infer<typeof extractedMenuSchema>): MenuImportDraft {
    const itemCount = extracted.categories.reduce((n, c) => n + c.items.length, 0);
    this.logger.log(
      `Extracted ${itemCount} items in ${extracted.categories.length} categories ` +
        `(${extracted.warnings.length} warnings)`,
    );

    if (itemCount === 0) {
      throw new BadRequestException(
        "That doesn't appear to contain a readable menu. Try a clearer photo or a page where the menu is text.",
      );
    }

    return {
      categories: extracted.categories.map((category) => ({
        name: category.name.trim(),
        items: category.items.map((item) => ({
          name: item.name.trim(),
          description: item.description.trim() || null,
          priceCents: parsePriceToCents(item.price),
        })),
      })),
      warnings: extracted.warnings,
    };
  }

  /**
   * The model ladder: every OpenRouter free model is tried in order. Two kinds
   * of failure ladder down: infrastructure (429/5xx/network) and BAD OUTPUT --
   * a free model that returns prose instead of the schema is just another
   * unavailable model, because the human review step downstream means a
   * weaker-but-valid read is always more useful than an error toast. Only a
   * definitive client error (4xx on our request shape) surfaces immediately:
   * every model would reject it identically.
   */
  private async runExtraction(
    currency: string,
    input: {
      prompt: string;
      image?: { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };
    },
  ): Promise<z.infer<typeof extractedMenuSchema>> {
    const system =
      'You transcribe restaurant menus into structured data. ' +
      'Rules: (1) Transcribe ONLY what is actually present -- never invent, ' +
      "embellish, or \"improve\" names, descriptions, or prices. (2) If an item's " +
      'price is illegible or absent, set price to an empty string and add a warning ' +
      'naming the item. (3) If an item has no given description, use an empty ' +
      "string -- do not write one. (4) Preserve the menu's own section headings as " +
      'category names; if the menu has no sections, use a single category named ' +
      '"Menu". (5) Prices are plain decimal strings without currency symbols, in ' +
      `the menu's own currency (expected: ${currency}). ` +
      '(6) List every item, even ones you are unsure about -- flag doubts as warnings. ' +
      'Respond with ONLY a JSON object of shape ' +
      '{"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string}]}],"warnings":[string]} ' +
      '-- no markdown fences, no commentary.';

    const attempts = this.openRouterModels;

    let lastError: unknown;

    for (const model of attempts) {
      try {
        const text = await this.callOpenRouter(model, system, input);

        // Free models fence and preface despite instructions. Take the outermost
        // JSON object; let zod be the judge of whether it's the right one.
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd <= jsonStart) throw new Error('no JSON in response');

        return extractedMenuSchema.parse(JSON.parse(text.slice(jsonStart, jsonEnd + 1)));
      } catch (err) {
        // A definitive rejection of OUR request shape (bad payload, oversized
        // image) would repeat on every model, so surface it. Everything else in
        // 4xx is provider trouble in disguise -- 404 is a free model gone from
        // the churning catalog, 402/403 are account state -- and ladders down.
        const status = err instanceof HttpStatusError ? err.status : undefined;
        if (status === 400 || status === 413 || status === 422) {
          throw new BadRequestException(
            "Couldn't read a menu from that. Try a clearer photo, or a page where the menu is text.",
          );
        }

        lastError = err;
        this.logger.warn(
          `${model} failed menu extraction ` +
            `(${(err as Error).message}) -- trying the next model`,
        );
      }
    }

    this.logger.error('Every model in the ladder failed menu extraction');
    throw new BadRequestException(
      lastError instanceof Error && lastError.message === 'no JSON in response'
        ? "Couldn't read a menu from that. Try a clearer photo with the text in focus."
        : 'Menu reading is briefly unavailable -- try again in a minute. You can always add items manually.',
    );
  }

  /** OpenRouter speaks the OpenAI chat shape; a data URL carries the image. */
  private async callOpenRouter(
    model: string,
    system: string,
    input: { prompt: string; image?: { mediaType: string; base64: string } },
  ): Promise<string> {
    const content: unknown[] = [{ type: 'text', text: input.prompt }];
    if (input.image) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${input.image.mediaType};base64,${input.image.base64}` },
      });
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${this.openRouterKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers; free-tier routing likes them.
        'HTTP-Referer': 'https://dinedirect.app',
        'X-Title': 'DineDirect menu import',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
    });

    if (!res.ok) throw new HttpStatusError(res.status, `OpenRouter ${res.status}`);

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error(body.error?.message ?? 'empty response');
    return text;
  }

  /**
   * Read a menu from a WEB PAGE -- the restaurant's old website, a Google Sites
   * page, wherever their menu already lives as text. Same review-first draft as
   * the photo path; only the ingestion differs.
   */
  async extractFromUrl(rawUrl: string, currency: string): Promise<MenuImportDraft> {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'Menu import is not configured on this server. You can still add menu items manually.',
      );
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException('That does not look like a web address');
    }

    /**
     * SSRF guard: this fetch runs FROM the server, which can see things the public
     * internet cannot (the database host, the metadata service, other containers).
     * A menu lives on a public website; anything that isn't plainly one is refused.
     */
    const host = url.hostname.toLowerCase();
    const isPrivate =
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '[::1]';
    if (isPrivate) {
      throw new BadRequestException('That address cannot be fetched from here');
    }

    let html: string;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        // A named bot UA gets flatly blocked by any site with even basic bot
        // protection -- which is most delivery marketplaces (SkipTheDishes,
        // DoorDash, UberEats all sit behind one). A browser UA at least gets
        // past naive User-Agent sniffing; it won't get past a real Cloudflare
        // challenge, but nothing short of a headless browser would, and that's
        // a lot of machinery for "read a menu off a page".
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new BadRequestException(
          res.status === 403 || res.status === 429
            ? "That site blocked our request -- some delivery marketplaces (SkipTheDishes, DoorDash, UberEats) don't allow this. Try the restaurant's own website instead, or add items by hand."
            : `That page answered ${res.status} -- check the link`,
        );
      }
      html = (await res.text()).slice(0, 800_000);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Could not fetch that page -- check the link and try again');
    }

    /**
     * Strip the page to prose. Crude on purpose: scripts, styles and tags go,
     * whitespace collapses, and the model -- which reads messy text far better
     * than any parser we would maintain -- does the rest.
     */
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60_000);

    if (text.length < 40) {
      throw new BadRequestException(
        "That page doesn't seem to contain a readable menu. If the menu is an image or a PDF, use Import from photo instead.",
      );
    }

    const extracted = await this.runExtraction(currency, {
      prompt:
        'The following is the text of a restaurant web page. Extract the menu from it.\n\n' +
        text,
    });

    return this.toDraft(extracted);
  }

  /**
   * One short, appetizing sentence for an item that has none -- the same free
   * OpenRouter ladder as the menu importer, just text instead of vision. Never
   * invents specifics the owner didn't provide (ingredients, allergens); it
   * writes around the name and category the way a menu copywriter would from
   * a one-line brief.
   */
  async generateDescription(
    name: string,
    categoryName: string | null,
    language: MenuDescriptionLanguage = 'EN',
  ): Promise<string> {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'AI description writing is not configured on this server.',
      );
    }

    // BOTH is two SEPARATE generations — French first, then English — joined by a
    // blank line. Asking one model call for "two lines" was unreliable (models
    // returned both on one line, so the languages ran together); two clean calls
    // guarantee the split, and the blank line makes it obvious in the field and on
    // the menu (which renders it with `white-space: pre-line`).
    if (language === 'BOTH') {
      const [fr, en] = await Promise.all([
        this.generateOneDescription(name, categoryName, 'FR'),
        this.generateOneDescription(name, categoryName, 'EN'),
      ]);
      const both = [fr, en].filter(Boolean).join('\n');
      if (both) return both;
      throw new BadRequestException('Could not write a description right now -- try again in a minute.');
    }

    return this.generateOneDescription(name, categoryName, language);
  }

  /**
   * Translate a short menu string to Quebec French, for the auto-bilingual menu.
   *
   * Returns '' when AI isn't configured or the call fails — the caller then leaves
   * the French field null and the storefront falls back to the original, so a
   * missing translation is never a blank on a customer's screen. Proper nouns and
   * dish names conventionally left untranslated (Poutine, Big Mac) are kept as-is.
   */
  async translateToFrench(text: string): Promise<string> {
    const source = text.trim();
    if (!source || !this.available) return '';

    const system =
      'You translate short restaurant menu text into natural Quebec French. Keep proper ' +
      'nouns, brand names and dish names that are conventionally left untranslated ' +
      '(e.g. "Poutine", "Big Mac", "Nachos") as they are. Preserve meaning and tone. ' +
      'Respond with ONLY the translation — no quotation marks, no notes, no preamble.';

    for (const model of this.openRouterModels) {
      try {
        const out = await this.callOpenRouter(model, system, { prompt: source });
        const cleaned = out.trim().replace(/^["']|["']$/g, '').trim().slice(0, 600);
        if (cleaned) return cleaned;
      } catch (err) {
        this.logger.warn(
          `${model} failed translation (${(err as Error).message}) -- trying the next model`,
        );
      }
    }
    return '';
  }

  /** One sentence in a single language. The building block for the bilingual mode. */
  private async generateOneDescription(
    name: string,
    categoryName: string | null,
    language: 'EN' | 'FR',
  ): Promise<string> {
    const base =
      'You write short, appetizing restaurant menu descriptions. Rules: plain, appealing ' +
      "language -- no purple prose, no invented ingredients or allergens you weren't given; " +
      'no quotation marks, no markdown, no preamble and no labels. Write exactly ONE sentence, ' +
      'under 120 characters, ';
    const system = base + (language === 'FR' ? 'in French (français).' : 'in English.');
    const prompt = categoryName
      ? `Menu item: "${name}" (category: ${categoryName}). Write the description.`
      : `Menu item: "${name}". Write the description.`;

    for (const model of this.openRouterModels) {
      try {
        const text = await this.callOpenRouter(model, system, { prompt });
        const cleaned = cleanOneLine(text);
        if (cleaned) return cleaned;
      } catch (err) {
        this.logger.warn(
          `${model} failed description generation (${(err as Error).message}) -- trying the next model`,
        );
      }
    }

    throw new BadRequestException('Could not write a description right now -- try again in a minute.');
  }

  /**
   * A few restaurant brand ideas from a one-line brief — a name, a tagline, and a
   * simple monogram spec (initials + colours + font family) the web turns into an
   * SVG lettermark. Free text models only: they can't draw a logo, but they are
   * good at naming and at picking a tasteful two-colour palette, and a clean
   * monogram from that is a real, usable logo for a small restaurant.
   */
  async generateBrandIdeas(brief: string): Promise<BrandIdea[]> {
    if (!this.available) {
      throw new ServiceUnavailableException('AI brand ideas are not configured on this server.');
    }

    const system =
      'You are a naming and branding assistant for independent restaurants. From the brief, ' +
      'return FIVE distinct ideas as STRICT JSON: an array of objects, each with keys: ' +
      'name (the restaurant name, 1-3 words), tagline (at most 6 words), initials (1-2 UPPERCASE ' +
      'letters drawn from the name), bg (background hex like "#1F2937"), fg (foreground hex with ' +
      'strong contrast against bg), font (exactly one of "serif", "sans", "script"). Vary the ' +
      'style and palette across the five. Respond with ONLY the JSON array — no markdown, no prose.';
    const prompt = `Brief: ${brief.trim() || 'a modern independent neighbourhood restaurant'}. Generate the ideas.`;

    for (const model of this.openRouterModels) {
      try {
        const text = await this.callOpenRouter(model, system, { prompt });
        const ideas = parseBrandIdeas(text);
        if (ideas.length) return ideas.slice(0, 6);
      } catch (err) {
        this.logger.warn(
          `${model} failed brand-idea generation (${(err as Error).message}) -- trying the next model`,
        );
      }
    }

    throw new BadRequestException('Could not generate brand ideas right now -- try again in a minute.');
  }

  /**
   * A catering-package description built from the restaurant's OWN menu — so "the
   * taco bar" reads back the actual dishes they serve, not invented ones. The
   * caller passes the item names; the model may only draw on those. Language picks
   * English, French, or both (French line then English), same as menu items.
   */
  async generateCateringDescription(
    itemNames: string[],
    packageName?: string,
    language: MenuDescriptionLanguage = 'EN',
  ): Promise<string> {
    if (!this.available) {
      throw new ServiceUnavailableException('AI description writing is not configured on this server.');
    }

    if (language === 'BOTH') {
      const [fr, en] = await Promise.all([
        this.generateOneCatering(itemNames, packageName, 'FR'),
        this.generateOneCatering(itemNames, packageName, 'EN'),
      ]);
      const both = [fr, en].filter(Boolean).join('\n');
      if (both) return both;
      throw new BadRequestException('Could not write a description right now -- try again in a minute.');
    }

    return this.generateOneCatering(itemNames, packageName, language);
  }

  private async generateOneCatering(
    itemNames: string[],
    packageName: string | undefined,
    language: 'EN' | 'FR',
  ): Promise<string> {
    const items = itemNames.slice(0, 60).join(', ');
    const system =
      'You write short, appetizing CATERING package descriptions for a restaurant feeding a ' +
      'party or event. You may ONLY reference dishes from the menu items provided — never invent ' +
      'a dish. Rules: 1-2 sentences, under 240 characters, name a few of the dishes, plain ' +
      'appealing language, no markdown, no quotation marks, no preamble and no labels. Write ' +
      (language === 'FR' ? 'in French (français).' : 'in English.');
    const prompt =
      `${packageName ? `Package name: "${packageName}". ` : ''}` +
      `Menu items available: ${items || 'a range of dishes'}. Write the catering package description.`;

    for (const model of this.openRouterModels) {
      try {
        const text = await this.callOpenRouter(model, system, { prompt });
        const cleaned = text.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').slice(0, 300);
        if (cleaned) return cleaned;
      } catch (err) {
        this.logger.warn(
          `${model} failed catering description (${(err as Error).message}) -- trying the next model`,
        );
      }
    }

    throw new BadRequestException('Could not write a description right now -- try again in a minute.');
  }
}

/** Which language(s) the AI writes a menu description in. */
export type MenuDescriptionLanguage = 'EN' | 'FR' | 'BOTH';

/** One AI-suggested brand: a name plus a monogram spec the web renders as SVG. */
export interface BrandIdea {
  name: string;
  tagline: string;
  initials: string;
  bg: string;
  fg: string;
  font: 'serif' | 'sans' | 'script';
}

/** A #RGB / #RRGGBB hex, or null. Guards the SVG against a model's stray value. */
function safeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

/**
 * Pull the brand ideas out of a model's reply. Text models wrap JSON in prose or
 * code fences and invent fields, so this extracts the first JSON array and rebuilds
 * each idea from scratch — every field validated, clamped and defaulted — rather
 * than trusting the shape. A malformed entry is dropped, not thrown.
 */
function parseBrandIdeas(text: string): BrandIdea[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const ideas: BrandIdea[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
    if (!name) continue;

    const initialsRaw = typeof o.initials === 'string' ? o.initials : name;
    const initials = initialsRaw.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() ||
      name.replace(/[^a-z]/gi, '').charAt(0).toUpperCase() ||
      '?';
    const font = o.font === 'serif' || o.font === 'script' ? o.font : 'sans';

    ideas.push({
      name,
      tagline: typeof o.tagline === 'string' ? o.tagline.trim().slice(0, 60) : '',
      initials,
      bg: safeHex(o.bg, '#1F2937'),
      fg: safeHex(o.fg, '#FFFFFF'),
      font,
    });
  }
  return ideas;
}

/** First non-empty line, de-quoted and capped — the single-language shape. */
function cleanOneLine(text: string): string {
  return text.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim().slice(0, 160);
}

/**
 * "12.99" -> 1299. Null when unparseable — the review form makes the owner fill it
 * in, which is strictly better than silently importing a $0 item that a customer
 * can then order for free.
 *
 * Handles both decimal conventions ("12.99" and "12,99") and thousands separators
 * ("1.299,00", "1,299.00"): whichever separator appears LAST is the decimal point.
 */
export function parsePriceToCents(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);

  let integerPart: string;
  let fractionPart: string;

  if (decimalAt === -1) {
    integerPart = cleaned;
    fractionPart = '';
  } else {
    const tail = cleaned.slice(decimalAt + 1);
    // "1.299" — three digits after the only separator is a thousands mark, not
    // 1 dollar 299 cents.
    if (tail.length === 3 && !(lastDot !== -1 && lastComma !== -1)) {
      integerPart = cleaned.slice(0, decimalAt) + tail;
      fractionPart = '';
    } else {
      integerPart = cleaned.slice(0, decimalAt);
      fractionPart = tail;
    }
  }

  const digits = (s: string) => s.replace(/[.,]/g, '');
  const whole = parseInt(digits(integerPart) || '0', 10);
  const frac = parseInt(fractionPart.padEnd(2, '0').slice(0, 2) || '0', 10);

  if (Number.isNaN(whole) || Number.isNaN(frac)) return null;

  const cents = whole * 100 + frac;
  // A menu item priced at 0 or over $10,000 is a misread, not a price.
  if (cents <= 0 || cents > 1_000_000) return null;

  return cents;
}
