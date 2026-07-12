import { Controller, Get, Param, Query, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Roles, TenantId } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

@ApiTags('customers')
@Controller('customers')
@UseGuards(ClerkAuthGuard)
export class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The CRM list. Sorted by lifetime spend — a restaurant's most valuable list is
   * "who are my regulars", and that is the first question this page should answer.
   */
  @Get()
  @Roles('MANAGER')
  async list(
    @TenantId() restaurantId: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const take = Math.min(Number(limit) || 50, 100);

    const customers = await this.prisma.customer.findMany({
      where: {
        restaurantId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { phone: { contains: search } },
                { email: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ totalSpentCents: 'desc' }, { createdAt: 'desc' }],
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = customers.length > take;
    return {
      customers: hasMore ? customers.slice(0, take) : customers,
      nextCursor: hasMore ? customers[take - 1].id : null,
    };
  }

  @Get(':id')
  @Roles('MANAGER')
  async get(@TenantId() restaurantId: string, @Param('id') id: string) {
    // The tenant filter is in the WHERE, not applied after the fetch — one
    // restaurant must never be able to read another's customer by guessing an id.
    const customer = await this.prisma.customer.findFirst({
      where: { id, restaurantId },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            fulfillment: true,
            totalCents: true,
            currency: true,
            createdAt: true,
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }
}

/** Read-only audit trail. OWNER-only: it's the record of who did what, including managers. */
@ApiTags('audit')
@Controller('audit-logs')
@UseGuards(ClerkAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles('OWNER')
  list(
    @TenantId() restaurantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.list(restaurantId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }
}
