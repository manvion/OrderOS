import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AddressInput } from '@orderos/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClerkService } from '../../common/auth/clerk.service';

/**
 * Customer accounts.
 *
 * The account exists to do exactly two things a guest can't: remember your address
 * and show you what you ordered last time. Everything else about ordering is
 * identical, on purpose.
 */
@Injectable()
export class CustomerAccountService {
  private readonly logger = new Logger(CustomerAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
  ) {}

  /**
   * Find or create this restaurant's Customer row for a signed-in account.
   *
   * The interesting case is the guest who comes back and signs up. Their Customer
   * row already exists — keyed by phone — carrying their whole order history. So
   * we CLAIM it rather than creating a second one, and their history is simply
   * there when they log in for the first time. Creating a fresh empty row instead
   * would silently orphan every order they'd ever placed.
   */
  async resolveAccount(restaurantId: string, clerkUserId: string) {
    const existing = await this.prisma.customer.findFirst({
      where: { restaurantId, clerkUserId },
      include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] } },
    });
    if (existing) return existing;

    const clerkUser = await this.clerk.getUser(clerkUserId);
    const email = (await this.clerk.getPrimaryEmail(clerkUserId))?.toLowerCase();
    const phone = clerkUser.primaryPhoneNumber?.phoneNumber;

    // Claim the guest record, if there is one. Phone first (it's our identity key),
    // then email.
    const guest = await this.prisma.customer.findFirst({
      where: {
        restaurantId,
        clerkUserId: null,
        OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
      },
    });

    if (guest) {
      const claimed = await this.prisma.customer.update({
        where: { id: guest.id },
        data: { clerkUserId },
        include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] } },
      });
      this.logger.log(
        `Customer ${clerkUserId} claimed their guest history at restaurant ${restaurantId} (${claimed.totalOrders} past orders)`,
      );
      return claimed;
    }

    // Genuinely new. Note we may have no phone yet — Clerk sign-up with email only
    // is common — so it's filled in at their first checkout.
    return this.prisma.customer.create({
      data: {
        restaurantId,
        clerkUserId,
        name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || 'Guest',
        phone: phone ?? '',
        email,
      },
      include: { addresses: true },
    });
  }

  /** Profile, saved addresses, and recent orders. What the account page shows. */
  async getProfile(restaurantId: string, clerkUserId: string) {
    const customer = await this.resolveAccount(restaurantId, clerkUserId);

    const orders = await this.prisma.order.findMany({
      where: {
        customerId: customer.id,
        payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillment: true,
        totalCents: true,
        currency: true,
        createdAt: true,
        trackingToken: true,
        items: { select: { name: true, quantity: true } },
      },
    });

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        totalOrders: customer.totalOrders,
        marketingOptIn: customer.marketingOptIn,
      },
      addresses: customer.addresses,
      orders,
    };
  }

  async addAddress(
    restaurantId: string,
    clerkUserId: string,
    input: AddressInput & { label?: string; notes?: string; isDefault?: boolean },
  ) {
    const customer = await this.resolveAccount(restaurantId, clerkUserId);

    // The first address a customer saves is their default, without being asked.
    const isFirst = customer.addresses.length === 0;
    const shouldDefault = input.isDefault ?? isFirst;

    return this.prisma.$transaction(async (tx) => {
      if (shouldDefault) {
        // Exactly one default. Otherwise checkout has to pick arbitrarily between
        // two "default" addresses, and will pick wrong.
        await tx.customerAddress.updateMany({
          where: { customerId: customer.id },
          data: { isDefault: false },
        });
      }

      return tx.customerAddress.create({
        data: {
          customerId: customer.id,
          label: input.label,
          street: input.street,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          country: input.country,
          latitude: input.latitude,
          longitude: input.longitude,
          notes: input.notes,
          isDefault: shouldDefault,
        },
      });
    });
  }

  async deleteAddress(restaurantId: string, clerkUserId: string, addressId: string) {
    const customer = await this.resolveAccount(restaurantId, clerkUserId);

    // Scoped by customerId, so one customer cannot delete another's address by id.
    const address = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId: customer.id },
    });
    if (!address) throw new NotFoundException('Address not found');

    await this.prisma.customerAddress.delete({ where: { id: addressId } });

    // Don't leave them with no default. Promote whatever's left.
    if (address.isDefault) {
      const next = await this.prisma.customerAddress.findFirst({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await this.prisma.customerAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  }

  /** Marketing consent. Transactional order messages never depend on this. */
  async setMarketingOptIn(restaurantId: string, clerkUserId: string, optIn: boolean) {
    const customer = await this.resolveAccount(restaurantId, clerkUserId);
    return this.prisma.customer.update({
      where: { id: customer.id },
      data: { marketingOptIn: optIn },
      select: { marketingOptIn: true },
    });
  }
}
