import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY, type AuditMeta } from '../auth/decorators';
import type { AuthedRequest } from '../auth/request-context';
import { AuditService } from './audit.service';

/**
 * Auto-audits any route decorated with @Audit(). Fires only on success — a
 * request that 403s or 400s never happened as far as the business record is
 * concerned, and logging attempted-but-rejected actions here would drown the
 * real signal. (Auth failures are captured separately in the app logs.)
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_KEY, context.getHandler());
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    return next.handle().pipe(
      tap((result) => {
        const restaurantId = req.restaurantId ?? req.publicRestaurantId;
        if (!restaurantId) return;

        // Prefer the id of the entity the handler returned; fall back to the
        // route param. Covers both create (id in the response) and update/delete
        // (id in the path).
        const entityId =
          (result as { id?: string } | undefined)?.id ??
          (req.params?.id as string | undefined) ??
          null;

        /**
         * A platform admin acting via a support session has no User row — their id
         * is a synthetic `support:<adminId>`. Writing that to `userId` would break
         * the foreign key, so it goes in metadata instead.
         *
         * The restaurant then reads their own audit log and sees "DineDirect support
         * did this, and here is who" — rather than a phantom staff member they
         * don't recognise, which is exactly the kind of thing that destroys trust.
         */
        const actorId = req.user?.id ?? null;
        const isSupport = actorId?.startsWith('support:') ?? false;

        void this.audit.log({
          restaurantId,
          action: meta.action,
          entityType: meta.entityType,
          entityId,
          userId: isSupport ? null : actorId,
          metadata: {
            method: req.method,
            path: req.path,
            body: this.summarizeBody(req.body),
            ...(isSupport ? { platformSupport: true, adminEmail: req.user?.email } : {}),
          },
          ipAddress: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        });
      }),
    );
  }

  /** Keep audit rows small: store shape, not payload. */
  private summarizeBody(body: unknown): Record<string, unknown> | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const entries = Object.entries(body as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(
      entries.map(([k, v]) => [
        k,
        Array.isArray(v) ? `[${v.length} items]` : typeof v === 'object' && v ? '{...}' : v,
      ]),
    );
  }
}
