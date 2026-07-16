import { Injectable, Logger } from '@nestjs/common';
import type { DemoRequestStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface DemoRequestInput {
  name: string;
  email: string;
  phone?: string;
  restaurantName?: string;
  city?: string;
  message?: string;
  interest?: string;
}

/**
 * Inbound "book a demo" / done-for-you setup leads from the marketing site.
 *
 * A lead is not a tenant — nobody has signed up. This is the top of the funnel the
 * platform works by hand: someone asks us to walk them through it (or to build their
 * site for them, for a one-time setup fee), we capture who they are, and they show
 * up on the admin panel to follow up.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: DemoRequestInput) {
    const lead = await this.prisma.demoRequest.create({
      data: {
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        phone: input.phone?.trim() || null,
        restaurantName: input.restaurantName?.trim() || null,
        city: input.city?.trim() || null,
        message: input.message?.trim() || null,
        interest: input.interest?.trim() || null,
      },
    });
    this.logger.log(`New demo request from ${lead.email}${lead.restaurantName ? ` (${lead.restaurantName})` : ''}`);
    return lead;
  }

  /** The leads list for the admin panel, newest first, optionally by status. */
  list(status?: DemoRequestStatus) {
    return this.prisma.demoRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** How many are still untouched — for the admin badge. */
  countNew() {
    return this.prisma.demoRequest.count({ where: { status: 'NEW' } });
  }

  /** Move a lead along the pipeline, stamping who acted and when. */
  updateStatus(id: string, status: DemoRequestStatus, adminEmail: string) {
    return this.prisma.demoRequest.update({
      where: { id },
      data: { status, handledByAdmin: adminEmail, handledAt: new Date() },
    });
  }
}
