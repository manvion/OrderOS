import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness. Azure restarts the container if this stops answering. */
  @Get()
  @Public()
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness. Azure pulls the instance out of the load balancer if this fails —
   * so it must check the things we genuinely cannot serve traffic without, and
   * nothing else. A Twilio outage does NOT make us unready; a dead Postgres does.
   */
  @Get('ready')
  @Public()
  async ready() {
    const [db, cache] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.client.ping(),
    ]);

    const checks = {
      database: db.status === 'fulfilled' ? 'ok' : 'down',
      redis: cache.status === 'fulfilled' ? 'ok' : 'down',
    };
    const healthy = Object.values(checks).every((v) => v === 'ok');

    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}
