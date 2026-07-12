import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { ClerkService } from './auth/clerk.service';
import { ClerkAuthGuard } from './auth/clerk-auth.guard';
import { PlatformAdminGuard } from './auth/platform-admin.guard';
import { PublicTenantGuard } from './auth/public-tenant.guard';

/** Cross-cutting providers every feature module can inject without re-importing. */
@Global()
@Module({
  providers: [ClerkService, ClerkAuthGuard, PublicTenantGuard, PlatformAdminGuard, AuditService],
  exports: [ClerkService, ClerkAuthGuard, PublicTenantGuard, PlatformAdminGuard, AuditService],
})
export class CommonModule {}
