import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { StaffRole } from '@dinedirect/shared';
import type { AuthedRequest, AuthUser } from './request-context';

/** Skip ClerkAuthGuard. Use on storefront and webhook routes. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum role required. Hierarchical: Roles(MANAGER) also admits OWNER.
 * Absent means "any authenticated staff member".
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/** Record this route's invocation in the audit log. */
export const AUDIT_KEY = 'audit';
export interface AuditMeta {
  action: string;
  entityType: string;
}
export const Audit = (action: string, entityType: string) =>
  SetMetadata(AUDIT_KEY, { action, entityType } satisfies AuditMeta);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    // Non-null: routes using this decorator are behind ClerkAuthGuard, which
    // rejects the request before the handler runs if there's no user.
    return req.user!;
  },
);

/**
 * The tenant this request acts on. On dashboard routes it comes from the user's
 * membership; on storefront routes from the subdomain. Handlers just ask for it.
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return (req.restaurantId ?? req.publicRestaurantId)!;
});
