import { Injectable, Logger } from '@nestjs/common';
import type { DeliveryProvider, Restaurant } from '@prisma/client';
import {
  CourierDeclinedError,
  CourierUnavailableError,
  type Courier,
  type CourierQuote,
  type CourierQuoteRequest,
} from './courier.interface';
import { DoorDashClient } from './doordash.client';
import { PorterCourier } from './porter.courier';
import { UberCourier } from './uber.courier';

/**
 * Which courier rides, and for how much.
 *
 * A restaurant can have Uber Direct on, DoorDash Drive on, or both. Both is the
 * interesting case and the reason this class exists: courier pricing is genuinely
 * volatile — surge, driver supply, distance banding — and the cheaper of the two on
 * any given order is not knowable in advance. It is frequently a dollar or two apart,
 * on every single delivery, which is real money to a restaurant running on 5% margins.
 *
 * So when both are enabled we quote BOTH, in parallel, and take the cheaper. That is
 * the whole product argument for multi-courier support, and it only works if the
 * comparison is honest — which means:
 *
 *   - A courier that DECLINES (address out of zone) is not an error. It is one fewer
 *     option. If the other one will go, we go.
 *   - A courier that is BROKEN (5xx, timeout) is also just one fewer option, and this
 *     is the failover that makes two couriers a resilience story as well as a pricing
 *     one: Uber having a bad afternoon no longer means a paid order cannot be
 *     delivered.
 *   - Only when EVERY enabled courier says no do we tell the customer no — and we
 *     tell them the reason a courier actually gave, not a generic failure.
 */
@Injectable()
export class CourierRouter {
  private readonly logger = new Logger(CourierRouter.name);

  constructor(
    private readonly uber: UberCourier,
    private readonly doordash: DoorDashClient,
    private readonly porter: PorterCourier,
  ) {}

  /** Is ANY courier usable at all? False on a deployment with no courier credentials. */
  get anyConfigured(): boolean {
    return this.uber.isConfigured || this.doordash.isConfigured || this.porter.isConfigured;
  }

  /** The couriers this restaurant has switched on AND we have credentials for. */
  enabledFor(
    restaurant: Pick<Restaurant, 'uberDirectEnabled' | 'doorDashEnabled' | 'porterEnabled'>,
  ): Courier[] {
    const couriers: Courier[] = [];

    if (restaurant.uberDirectEnabled && this.uber.isConfigured) couriers.push(this.uber);
    if (restaurant.doorDashEnabled && this.doordash.isConfigured) couriers.push(this.doordash);
    if (restaurant.porterEnabled && this.porter.isConfigured) couriers.push(this.porter);

    return couriers;
  }

  /** The client for a delivery we already dispatched. Keyed on what we stored. */
  forProvider(provider: DeliveryProvider): Courier {
    switch (provider) {
      case 'UBER':
        return this.uber;
      case 'DOORDASH':
        return this.doordash;
      case 'PORTER':
        return this.porter;
      default:
        // SELF has no API. Reaching here means someone tried to ask a restaurant's own
        // moped rider for a tracking update, which is a bug in the caller, not a
        // network problem — so it throws rather than returning a null client that
        // would fail confusingly three frames later.
        throw new Error(`${provider} deliveries are not dispatched through a courier API`);
    }
  }

  /**
   * Quote every enabled courier and return them cheapest-first.
   *
   * Deliberately returns a LIST, not just the winner. The dispatch path needs the
   * runners-up: a quote can expire, or be rejected at accept-time, in the seconds
   * between the customer paying and the kitchen pressing Ready — and having the
   * second-cheapest already in hand is the difference between failing over instantly
   * and re-quoting the world.
   *
   * Returns `[]` when every courier declined or broke. The caller must treat that as
   * "we cannot deliver here", never as "it's free".
   */
  async quoteAll(
    restaurant: Pick<Restaurant, 'uberDirectEnabled' | 'doorDashEnabled' | 'porterEnabled'>,
    req: CourierQuoteRequest,
  ): Promise<{ quotes: CourierQuote[]; declineReason: string | null }> {
    const couriers = this.enabledFor(restaurant);
    if (couriers.length === 0) return { quotes: [], declineReason: null };

    // In parallel. Sequentially quoting two couriers would double the latency of a
    // checkout page that is already waiting on a network call, to save nothing.
    const settled = await Promise.allSettled(couriers.map((c) => c.quote(req)));

    const quotes: CourierQuote[] = [];
    let declineReason: string | null = null;

    settled.forEach((result, i) => {
      const provider = couriers[i].provider;

      if (result.status === 'fulfilled') {
        quotes.push(result.value);
        return;
      }

      const err = result.reason as Error;

      if (err instanceof CourierDeclinedError) {
        // A real answer from a working courier: "not to that address". Keep the FIRST
        // one to show the customer if nobody else will go — it is a specific,
        // actionable sentence ("outside our delivery zone"), which a generic failure
        // message is not.
        declineReason ??= err.message;
        this.logger.log(`${provider} declined: ${err.message}`);
        return;
      }

      // Broken, not declining. Log it loudly — an outage that silently costs us the
      // cheaper courier on every order is an expensive thing to not notice — but do
      // not surface it to the customer, who cannot act on it.
      this.logger.error(`${provider} unavailable: ${err.message}`);
    });

    // Cheapest first. This is the entire point.
    quotes.sort((a, b) => a.feeCents - b.feeCents);

    if (quotes.length > 1) {
      const [best, ...rest] = quotes;
      const saving = rest[rest.length - 1].feeCents - best.feeCents;
      this.logger.log(
        `${best.provider} won at ${best.feeCents} (saving ${saving} vs ${rest[rest.length - 1].provider})`,
      );
    }

    return { quotes, declineReason };
  }

  /**
   * The single cheapest courier that will take it, or null.
   *
   * `CourierUnavailableError` is deliberately NOT thrown here: to a caller deciding
   * whether to show a delivery option, "every courier is down" and "no courier will
   * come here" have the same answer — don't offer delivery — and the distinction is
   * for our logs, not the customer's checkout page.
   */
  async bestQuote(
    restaurant: Pick<Restaurant, 'uberDirectEnabled' | 'doorDashEnabled' | 'porterEnabled'>,
    req: CourierQuoteRequest,
  ): Promise<{ quote: CourierQuote | null; declineReason: string | null }> {
    const { quotes, declineReason } = await this.quoteAll(restaurant, req);
    return { quote: quotes[0] ?? null, declineReason };
  }
}

export { CourierDeclinedError, CourierUnavailableError };
