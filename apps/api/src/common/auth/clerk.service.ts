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
      this.logger.debug(`Token verification failed: ${(err as Error).message}`);
      return null;
    }
  }

  async getUser(clerkUserId: string) {
    return this.client.users.getUser(clerkUserId);
  }

  /** Primary email for a Clerk user, or null if they somehow have none. */
  async getPrimaryEmail(clerkUserId: string): Promise<string | null> {
    const user = await this.client.users.getUser(clerkUserId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  }
}
