import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, verifyToken, type ClerkClient } from '@clerk/backend';

export interface ClerkClaims {
  sub: string; // Clerk user id
  sid?: string; // session id
  email?: string;
}

@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly client: ClerkClient;
  private readonly secretKey: string;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.getOrThrow<string>('CLERK_SECRET_KEY');
    this.client = createClerkClient({
      secretKey: this.secretKey,
      publishableKey: this.config.get<string>('CLERK_PUBLISHABLE_KEY'),
    });
  }

  /**
   * Verify a Clerk session JWT. Returns null on any failure — callers turn that
   * into a 401. We never surface the underlying JWT error to the client, since
   * "expired" vs "malformed" vs "wrong issuer" is information an attacker can use.
   */
  async verifySessionToken(token: string): Promise<ClerkClaims | null> {
    try {
      const claims = await verifyToken(token, { secretKey: this.secretKey });
      return { sub: claims.sub, sid: claims.sid as string | undefined };
    } catch (err) {
      /**
       * WARN, not debug. The comment above is right that the CALLER must stay
       * opaque — the HTTP response never says why. But the server's own logs are
       * read by the operator, not the attacker, and this line is the only place
       * that knows whether a platform-wide 401 storm is "expired token" (client
       * clock/refresh bug), "invalid signature" (key rotated), or "wrong issuer"
       * (two Clerk instances). At debug level it was invisible in production,
       * which turned each of those into an afternoon of guessing.
       */
      this.logger.warn(`Token verification failed: ${(err as Error).message}`);
      return null;
    }
  }

  async getUser(clerkUserId: string) {
    return this.client.users.getUser(clerkUserId);
  }

  /** Find a Clerk account by email, or null. Checked before we try to create one. */
  async findUserByEmail(email: string) {
    const res = await this.client.users.getUserList({ emailAddress: [email], limit: 1 });
    return res.data[0] ?? null;
  }

  /**
   * Create a Clerk account with a password the PLATFORM chose.
   *
   * Used only by admin onboarding, when an operator opts to hand a restaurant an
   * initial password (which the owner changes later) instead of the default email
   * invite. It IS a real trade-off — a password we set is one we briefly knew — so
   * it's deliberately opt-in per onboarding, never the default.
   */
  async createUserWithPassword(email: string, password: string) {
    return this.client.users.createUser({
      emailAddress: [email],
      password,
    });
  }

  /** Primary email for a Clerk user, or null if they somehow have none. */
  async getPrimaryEmail(clerkUserId: string): Promise<string | null> {
    const user = await this.client.users.getUser(clerkUserId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  }
}
