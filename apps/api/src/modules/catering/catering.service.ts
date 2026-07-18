import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CateringStatus, FulfillmentType, Prisma } from '@prisma/client';
import { planAllows } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  assertRestaurantCapability,
  isMissingPlanColumn,
} from '../../common/plan/plan.util';
import { PaymentsService } from '../payments/payments.service';

export interface CateringPackageInput {
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  pricePerPersonCents: number;
  minPeople?: number;
  maxPeople?: number | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface SubmitCateringInput {
  type: 'PACKAGE' | 'CUSTOM';
  packageId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  headCount: number;
  eventDate: string;
  fulfillment: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  message?: string;
}

/**
 * Parties & catering.
 *
 * Two shapes of demand: a fixed per-head PACKAGE the customer sizes and pays for
 * online, and a CUSTOM job that's a lead for the restaurant to quote. Both land in
 * one admin inbox; only PACKAGE carries a price and a Stripe checkout.
 *
 * Gated on the CATERING capability (Growth/Pro). The public reads fail OPEN to
 * "no catering" when the plan columns aren't migrated, exactly like the storefront.
 */
@Injectable()
export class CateringService {
  private readonly logger = new Logger(CateringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  // --- Storefront (public) -------------------------------------------------

  /**
   * Whether this restaurant offers catering AND has at least the capability. Drives
   * whether the storefront even shows the "Catering & Parties" entry.
   */
  async publicOffering(restaurantId: string) {
    let allowed = true;
    try {
      const r = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { planTier: true },
      });
      allowed = r ? planAllows(r.planTier, 'CATERING') : false;
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
      // Columns not migrated — treat as no catering rather than 500 the storefront.
      allowed = false;
    }

    if (!allowed) return { enabled: false as const, packages: [] };

    const packages = await this.prisma.cateringPackage.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { enabled: true as const, packages };
  }

  /** A customer submitting a package order (→ pay) or a custom enquiry (→ lead). */
  async submitRequest(
    restaurantId: string,
    input: SubmitCateringInput,
  ): Promise<{ requestId: string; checkoutUrl: string | null }> {
    await assertRestaurantCapability(this.prisma, restaurantId, 'CATERING');

    const eventDate = new Date(input.eventDate);
    if (Number.isNaN(eventDate.getTime())) {
      throw new BadRequestException('Pick a valid event date');
    }
    // Midnight today, so "today" itself is still allowed.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (eventDate < today) throw new BadRequestException('The event date is in the past');

    if (input.fulfillment === 'DELIVERY' && !input.deliveryAddress?.trim()) {
      throw new BadRequestException('Enter a delivery address');
    }

    const base = {
      restaurantId,
      customerName: input.customerName.trim(),
      customerEmail: input.customerEmail.trim(),
      customerPhone: input.customerPhone.trim(),
      headCount: input.headCount,
      eventDate,
      fulfillment: input.fulfillment as FulfillmentType,
      deliveryAddress: input.fulfillment === 'DELIVERY' ? input.deliveryAddress?.trim() : null,
      message: input.message?.trim() || null,
    };

    if (input.type === 'PACKAGE') {
      if (!input.packageId) throw new BadRequestException('Choose a package');
      const pkg = await this.prisma.cateringPackage.findFirst({
        where: { id: input.packageId, restaurantId, isActive: true },
      });
      if (!pkg) throw new NotFoundException('That package is no longer available');

      if (input.headCount < pkg.minPeople) {
        throw new BadRequestException(`This package is for ${pkg.minPeople} people or more`);
      }
      if (pkg.maxPeople && input.headCount > pkg.maxPeople) {
        throw new BadRequestException(`This package is for up to ${pkg.maxPeople} people`);
      }

      const totalCents = pkg.pricePerPersonCents * input.headCount;
      const request = await this.prisma.cateringRequest.create({
        data: {
          ...base,
          type: 'PACKAGE',
          packageId: pkg.id,
          packageName: pkg.name,
          pricePerPersonCents: pkg.pricePerPersonCents,
          totalCents,
        },
      });

      // Try to open an online checkout; null when the restaurant can't take a card
      // here (Razorpay/India, or no connected Stripe account) — the enquiry still
      // stands and the restaurant arranges payment.
      let checkoutUrl: string | null = null;
      try {
        const checkout = await this.payments.createCateringCheckout(request.id);
        checkoutUrl = checkout?.checkoutUrl ?? null;
      } catch (err) {
        this.logger.warn(`Catering checkout could not be created: ${(err as Error).message}`);
      }

      return { requestId: request.id, checkoutUrl };
    }

    // CUSTOM: a lead, no payment.
    const request = await this.prisma.cateringRequest.create({
      data: { ...base, type: 'CUSTOM' },
    });
    return { requestId: request.id, checkoutUrl: null };
  }

  // --- Admin: packages -----------------------------------------------------

  listPackages(restaurantId: string) {
    return this.prisma.cateringPackage.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createPackage(restaurantId: string, input: CateringPackageInput, userId?: string) {
    await assertRestaurantCapability(this.prisma, restaurantId, 'CATERING');
    const pkg = await this.prisma.cateringPackage.create({
      data: {
        restaurantId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        imageUrl: input.imageUrl || null,
        pricePerPersonCents: input.pricePerPersonCents,
        minPeople: input.minPeople ?? 10,
        maxPeople: input.maxPeople ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await this.audit.log({
      restaurantId,
      userId,
      action: 'catering.package_created',
      entityType: 'CateringPackage',
      entityId: pkg.id,
      metadata: { name: pkg.name },
    });
    return pkg;
  }

  async updatePackage(
    restaurantId: string,
    id: string,
    input: Partial<CateringPackageInput>,
    userId?: string,
  ) {
    await this.ownPackage(restaurantId, id);
    const data: Prisma.CateringPackageUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl || null;
    if (input.pricePerPersonCents !== undefined) data.pricePerPersonCents = input.pricePerPersonCents;
    if (input.minPeople !== undefined) data.minPeople = input.minPeople;
    if (input.maxPeople !== undefined) data.maxPeople = input.maxPeople ?? null;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    const pkg = await this.prisma.cateringPackage.update({ where: { id }, data });
    await this.audit.log({
      restaurantId,
      userId,
      action: 'catering.package_updated',
      entityType: 'CateringPackage',
      entityId: id,
      metadata: { name: pkg.name },
    });
    return pkg;
  }

  async deletePackage(restaurantId: string, id: string, userId?: string) {
    await this.ownPackage(restaurantId, id);
    await this.prisma.cateringPackage.delete({ where: { id } });
    await this.audit.log({
      restaurantId,
      userId,
      action: 'catering.package_deleted',
      entityType: 'CateringPackage',
      entityId: id,
    });
    return { success: true };
  }

  // --- Admin: requests inbox ----------------------------------------------

  listRequests(restaurantId: string) {
    return this.prisma.cateringRequest.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async updateRequestStatus(
    restaurantId: string,
    id: string,
    status: CateringStatus,
    userId?: string,
  ) {
    const existing = await this.prisma.cateringRequest.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Request not found');

    const request = await this.prisma.cateringRequest.update({
      where: { id },
      data: { status },
    });
    await this.audit.log({
      restaurantId,
      userId,
      action: 'catering.request_status_changed',
      entityType: 'CateringRequest',
      entityId: id,
      metadata: { status },
    });
    return request;
  }

  private async ownPackage(restaurantId: string, id: string) {
    // No capability assert on edit/remove — an owner who lost CATERING can still
    // manage what they already made; only create is gated, matching the rest of the
    // app. Tenant ownership is the check that matters here.
    const pkg = await this.prisma.cateringPackage.findFirst({ where: { id, restaurantId } });
    if (!pkg) throw new NotFoundException('Package not found');
    return pkg;
  }
}
