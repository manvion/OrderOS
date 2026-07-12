import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ClerkService } from './clerk.service';
import type { AuthedRequest } from './request-context';

/** Set by OptionalCustomerGuard when a customer happens to be signed in. */
export interface CustomerAuthedRequest extends AuthedRequest {
  /** The Clerk id of a signed-in CUSTOMER. Undefined for guests — which is fine. */
  customerClerkUserId?: string;
}

/**
 * Resolves a signed-in customer if there is one, and shrugs if there isn't.
 *
 * This is the opposite of ClerkAuthGuard, and deliberately so. That guard REQUIRES
 * a session and a staff membership. This one requires nothing: it looks for a
 * bearer token, verifies it if present, and always returns true.
 *
 * That asymmetry is the whole design. Guest checkout is not a degraded fallback,
 * it is the default path — making someone create an account before they can buy a
 * burger is the fastest known way to lose the sale. So every storefront route works
 * identically whether or not anyone is logged in; being signed in only means we can
 * pre-fill their details and offer to save the address afterwards.
 *
 * A customer's Clerk account is the SAME Clerk account a staff member would have.
 * We don't check membership here, because a customer of Joe's has no membership at
 * Joe's — and shouldn't need one to order a sandwich.
 */
@Injectable()
export class OptionalCustomerGuard implements CanActivate {
  constructor(private readonly clerk: ClerkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CustomerAuthedRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return true; // a guest. Entirely normal.
    }

    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (claims) {
      req.customerClerkUserId = claims.sub;
    }

    // An invalid or expired token does NOT reject the request — it just means we
    // treat them as a guest. A customer whose session quietly expired mid-order
    // must still be able to check out; failing their checkout over it would be
    // choosing our convenience over their dinner.
    return true;
  }
}
