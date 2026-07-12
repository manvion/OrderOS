import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withRetry } from '../../common/resilience/retry';

export interface VercelDnsRecord {
  type: 'A' | 'CNAME' | 'TXT';
  name: string;
  value: string;
}

export interface VercelDomainStatus {
  /** Vercel has the domain on the project. */
  configured: boolean;
  /** DNS resolves to Vercel and the certificate is serving. */
  verified: boolean;
  /** What the owner must add to their DNS, verbatim. */
  requiredRecords: VercelDnsRecord[];
  error?: string;
}

/** Where Vercel's edge answers. Public and stable; Vercel documents both. */
export const VERCEL_APEX_A_RECORD = '76.76.21.21';
export const VERCEL_CNAME_TARGET = 'cname.vercel-dns.com';

/**
 * Two-part public suffixes.
 *
 * `joesburgers.co.uk` has three labels but IS an apex — counting dots gets it
 * wrong, and getting it wrong means telling a British restaurant to put a CNAME on
 * their apex, which DNS forbids and which fails silently. That is the precise bug
 * this whole feature exists to prevent, so it must not be the bug we ship.
 *
 * This is not the full Public Suffix List (which is ~9,000 entries and changes).
 * It is the suffixes our markets actually use — UK, India, Australia, Canada, NZ,
 * Brazil, South Africa. If we start selling somewhere else, add it here or pull in
 * `psl`.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'com.mx', 'com.sg',
  'co.za', 'co.jp', 'com.tr',
]);

/**
 * Is this the registrable domain itself, rather than something under it?
 *
 * Exported and pure so it can be tested without a Vercel token — the correctness of
 * every DNS instruction we give hangs off this one boolean.
 */
export function isApexDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  if (labels.length < 2) return false;
  if (labels.length === 2) return true;
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(-2).join('.'));
}

/**
 * The DNS records the owner must create at their registrar, verbatim.
 *
 * An apex domain (joesburgers.com, joesburgers.co.uk) CANNOT have a CNAME — that is
 * a DNS rule, not a Vercel one — so it gets an A record. Anything below the apex
 * (order.joesburgers.com) gets a CNAME, whose "name" is every label above the
 * registrable domain: `shop.order.joesburgers.com` -> name `shop.order`.
 */
export function requiredDnsRecords(domain: string): VercelDnsRecord[] {
  const host = domain.toLowerCase();

  if (isApexDomain(host)) {
    return [{ type: 'A', name: '@', value: VERCEL_APEX_A_RECORD }];
  }

  const labels = host.split('.');
  const apexLabelCount = TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  const name = labels.slice(0, labels.length - apexLabelCount).join('.');

  return [{ type: 'CNAME', name, value: VERCEL_CNAME_TARGET }];
}

/**
 * Vercel's Domains API.
 *
 * The whole custom-domain feature is: add the domain to our ONE multi-tenant Vercel
 * project, tell the restaurant which DNS records to create, then poll until Vercel
 * says the certificate is live.
 *
 * We do not build or deploy anything per restaurant. There is one deployment; a
 * custom domain is a hostname pointed at it. A repo-and-build per restaurant would
 * mean a thousand builds and a security fix rolled out a thousand times.
 */
@Injectable()
export class VercelClient {
  private readonly logger = new Logger(VercelClient.name);
  private static readonly BASE = 'https://api.vercel.com';

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.token && this.projectId);
  }

  private get token(): string | undefined {
    return this.config.get<string>('VERCEL_TOKEN');
  }

  private get projectId(): string | undefined {
    return this.config.get<string>('VERCEL_PROJECT_ID');
  }

  /** Team-scoped tokens must pass teamId on every call, or everything 404s. */
  private get teamQuery(): string {
    const teamId = this.config.get<string>('VERCEL_TEAM_ID');
    return teamId ? `?teamId=${teamId}` : '';
  }

  assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Custom domains are not available on this deployment (VERCEL_TOKEN / VERCEL_PROJECT_ID are not set)',
      );
    }
  }

  /**
   * Attach a domain to the project.
   *
   * Idempotent: Vercel returns a "already exists" style error for a domain already
   * on the project, which we treat as success. A restaurant clicking "Add" twice
   * must not end up in a failed state.
   */
  async addDomain(domain: string): Promise<VercelDomainStatus> {
    this.assertConfigured();

    try {
      await this.request(`/v10/projects/${this.projectId}/domains${this.teamQuery}`, {
        method: 'POST',
        body: JSON.stringify({ name: domain }),
      });
      this.logger.log(`Added ${domain} to the Vercel project`);
    } catch (err) {
      const message = (err as Error).message;

      // Already ours — fine, carry on and report its real status.
      const alreadyOurs =
        message.includes('domain_already_in_use') || message.includes('already exists');

      if (!alreadyOurs) {
        // The important failure: someone ELSE'S Vercel account holds this domain.
        // Say so plainly, because the fix is theirs, not ours.
        if (message.includes('domain_taken') || message.includes('forbidden')) {
          throw new Error(
            'That domain is already connected to a different Vercel account. Remove it there first.',
          );
        }
        throw err;
      }
    }

    return this.getStatus(domain);
  }

  /**
   * What is this domain's real state right now?
   *
   * Two calls, because Vercel splits them: `/config` says whether DNS is pointing at
   * us, and the domain record says whether the certificate is issued. A domain can
   * be "verified" with DNS still misconfigured, which is exactly the confusing case
   * this collapses into one honest answer.
   */
  async getStatus(domain: string): Promise<VercelDomainStatus> {
    this.assertConfigured();

    const [config, record] = await Promise.all([
      this.request<{
        misconfigured: boolean;
        // Vercel's suggested records when DNS is wrong.
        recommendedIPv4?: Array<{ value: string[] }>;
        recommendedCNAME?: Array<{ value: string }>;
      }>(`/v6/domains/${domain}/config${this.teamQuery}`),

      this.request<{ verified: boolean; verification?: Array<{ type: string; domain: string; value: string }> }>(
        `/v9/projects/${this.projectId}/domains/${domain}${this.teamQuery}`,
      ).catch(() => null),
    ]);

    const requiredRecords = requiredDnsRecords(domain);

    // Vercel may also want a TXT record to prove ownership (it does when the domain
    // is attached elsewhere). Pass it straight through — never paraphrase it.
    for (const v of record?.verification ?? []) {
      if (v.type.toUpperCase() === 'TXT') {
        requiredRecords.push({ type: 'TXT', name: v.domain, value: v.value });
      }
    }

    return {
      configured: true,
      verified: Boolean(record?.verified) && !config.misconfigured,
      requiredRecords,
      error: config.misconfigured ? 'DNS is not pointing at us yet' : undefined,
    };
  }

  async removeDomain(domain: string): Promise<void> {
    this.assertConfigured();
    try {
      await this.request(`/v9/projects/${this.projectId}/domains/${domain}${this.teamQuery}`, {
        method: 'DELETE',
      });
      this.logger.log(`Removed ${domain} from the Vercel project`);
    } catch (err) {
      // Already gone is a success.
      this.logger.warn(`Could not remove ${domain} from Vercel: ${(err as Error).message}`);
    }
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    return withRetry(
      async () => {
        const res = await fetch(`${VercelClient.BASE}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            ...init.headers,
          },
          signal: AbortSignal.timeout(12_000),
        });

        const text = await res.text();
        const body = text ? JSON.parse(text) : {};

        if (!res.ok) {
          const message = body?.error?.code ?? body?.error?.message ?? `Vercel ${res.status}`;
          const error = new Error(message);
          // 4xx is our fault or theirs and will not fix itself — don't retry it.
          (error as Error & { retryable?: boolean }).retryable = res.status >= 500;
          throw error;
        }

        return body as T;
      },
      {
        attempts: 3,
        baseDelayMs: 400,
        isRetryable: (err) => (err as Error & { retryable?: boolean }).retryable === true,
        label: `Vercel ${path}`,
        logger: this.logger,
      },
    );
  }
}
