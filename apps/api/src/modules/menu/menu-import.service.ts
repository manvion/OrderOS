import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * A menu photo -> a structured menu, ready to review and import.
 *
 * Typing a menu into a form is the single most tedious step of onboarding — a
 * 60-item menu is an hour of data entry, and it lands exactly where a restaurant
 * owner's patience is thinnest: before they've made a single sale on the platform.
 * Every abandoned onboarding is a restaurant that wanted the product and gave up.
 * So instead: photograph the physical menu they already have, and Claude reads it.
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

/**
 * The same schema, as the raw JSON Schema the API's structured-output enforcement
 * takes. Written by hand rather than derived: the SDK's `zodOutputFormat` helper
 * requires zod v4 and this codebase is on v3 — a major-version bump across three
 * packages is not a price worth paying for one derivation. `additionalProperties:
 * false` + exhaustive `required` on every object are what the API demands of a
 * strict schema. Keep the two in lockstep.
 */
const EXTRACTED_MENU_JSON_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: {
                  type: 'string',
                  description: 'The printed description, or empty string if none. Never invented.',
                },
                price: {
                  type: 'string',
                  description:
                    'The printed price as a plain decimal string, e.g. "12.99". Empty string if illegible.',
                },
              },
              required: ['name', 'description', 'price'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'items'],
        additionalProperties: false,
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Anything illegible or uncertain, one human-readable sentence each.',
    },
  },
  required: ['categories', 'warnings'],
  additionalProperties: false,
} as const;

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
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    // No key -> the feature reports itself unavailable and the dashboard hides the
    // button. Menu entry still works by hand; this is an accelerant, not a gate.
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  get available(): boolean {
    return this.client !== null;
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
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Menu import is not configured on this server (ANTHROPIC_API_KEY is not set). ' +
          'You can still add menu items manually.',
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

    const response = await this.runExtraction(currency, [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp',
          data: file.buffer.toString('base64'),
        },
      },
      {
        type: 'text',
        text: 'Transcribe this menu. Every legible item, exactly as printed.',
      },
    ]);

    return this.toDraft(response);
  }

  /** Shared tail of every ingestion path: schema-validated response -> reviewed draft. */
  private toDraft(response: Anthropic.Message): MenuImportDraft {
    // A refusal or truncation yields no valid JSON. There is nothing sinister about
    // a menu, so this is effectively "the image was not a menu" — say so usefully.
    if (response.stop_reason === 'refusal') {
      throw new BadRequestException(
        "Couldn't read a menu in that image. Try a straight-on photo with the text in focus.",
      );
    }

    const text = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    )?.text;

    // The API enforces the schema, so this parse+validate should never fail — but
    // "should never" is not a policy for input that came off a network, and the zod
    // pass is also what gives the rest of the method its types.
    let extracted: z.infer<typeof extractedMenuSchema>;
    try {
      extracted = extractedMenuSchema.parse(JSON.parse(text ?? ''));
    } catch {
      this.logger.error('Structured output failed to validate — menu extraction dropped');
      throw new BadRequestException(
        "Couldn't read a menu in that image. Try a straight-on photo with the text in focus.",
      );
    }

    const itemCount = extracted.categories.reduce((n, c) => n + c.items.length, 0);
    this.logger.log(
      `Extracted ${itemCount} items in ${extracted.categories.length} categories ` +
        `(${extracted.warnings.length} warnings, ${response.usage.input_tokens}+${response.usage.output_tokens} tokens)`,
    );

    if (itemCount === 0) {
      throw new BadRequestException(
        "That image doesn't appear to contain a readable menu. Try better lighting or a closer shot.",
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
   * The model ladder. Opus first -- menus are hard reads and it is the best eye
   * we have. If IT has a bad minute (overload, rate limit, timeout), the job
   * falls to Sonnet rather than to the owner: a slightly-less-sharp read that a
   * human reviews anyway beats an error toast every time. Only infrastructure
   * failures ladder down; a 400 means the REQUEST is wrong and every model would
   * agree, so it surfaces immediately.
   */
  private static readonly MODEL_LADDER = ['claude-opus-4-8', 'claude-sonnet-5'] as const;

  private async runExtraction(
    currency: string,
    content: Anthropic.ContentBlockParam[],
  ): Promise<Anthropic.Message> {
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
      '(6) List every item, even ones you are unsure about -- flag doubts as warnings.';

    let lastError: unknown;

    for (const model of MenuImportService.MODEL_LADDER) {
      try {
        return await this.client!.messages.create({
          model,
          max_tokens: 16000,
          // Menus are hard reads -- dense layouts, decorative fonts, glare on
          // laminate. Let the model decide when the input deserves thought.
          thinking: { type: 'adaptive' },
          system,
          messages: [{ role: 'user', content }],
          output_config: {
            format: {
              type: 'json_schema' as const,
              schema: EXTRACTED_MENU_JSON_SCHEMA as unknown as Record<string, unknown>,
            },
          },
        });
      } catch (err) {
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        const retryable =
          err instanceof Anthropic.APIConnectionError ||
          status === 429 ||
          (typeof status === 'number' && status >= 500);

        if (!retryable) throw err;

        lastError = err;
        this.logger.warn(
          `${model} unavailable for menu extraction (${status ?? 'network'}) -- trying the next model`,
        );
      }
    }

    throw lastError;
  }

  /**
   * Read a menu from a WEB PAGE -- the restaurant's old website, a Google Sites
   * page, wherever their menu already lives as text. Same review-first draft as
   * the photo path; only the ingestion differs.
   */
  async extractFromUrl(rawUrl: string, currency: string): Promise<MenuImportDraft> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Menu import is not configured on this server (ANTHROPIC_API_KEY is not set). ' +
          'You can still add menu items manually.',
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
        headers: { 'User-Agent': 'OrderOS-MenuImport/1.0' },
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new BadRequestException(`That page answered ${res.status} -- check the link`);
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

    const response = await this.runExtraction(currency, [
      {
        type: 'text',
        text:
          'The following is the text of a restaurant web page. Extract the menu from it.\n\n' +
          text,
      },
    ]);

    return this.toDraft(response);
  }
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
