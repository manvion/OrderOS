import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  restaurantId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Field names whose values are stripped before they reach the audit table. */
const REDACTED_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'card',
  'cvc',
  'stripeSecretKey',
];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an audit entry. Deliberately swallows its own errors: an audit write
   * failing must never fail the business operation that triggered it. It logs
   * loudly instead, so the gap is visible in monitoring.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          restaurantId: entry.restaurantId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          userId: entry.userId ?? null,
          // Cast: our metadata is plain JSON-serialisable data, but Prisma's
          // InputJsonValue can't be proven to accept an open Record at compile time.
          metadata: entry.metadata
            ? (this.redact(entry.metadata) as Prisma.InputJsonValue)
            : undefined,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent?.slice(0, 500) ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log for ${entry.action}`, err as Error);
    }
  }

  private redact(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const isSensitive = REDACTED_KEYS.some((k) => key.toLowerCase().includes(k.toLowerCase()));
      if (isSensitive) {
        out[key] = '[redacted]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = this.redact(value as Record<string, unknown>);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async list(restaurantId: string, opts: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(opts.limit ?? 50, 200);
    return this.prisma.auditLog.findMany({
      where: { restaurantId },
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    });
  }
}
