import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { validateEnv } from './config/env';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';

import { AdminModule } from './modules/admin/admin.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { DomainsModule } from './modules/domains/domains.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { HealthController } from './modules/health/health.controller';
import { MenuModule } from './modules/menu/menu.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { QrModule } from './modules/qr/qr.module';
import { RestaurantsModule } from './modules/restaurants/restaurants.module';
import { StorageModule } from './modules/storage/storage.module';
import { StorefrontModule } from './modules/storefront/storefront.module';
import { WidgetModule } from './modules/widget/widget.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Boot fails loudly on a bad env rather than 500ing at the first payment.
      validate: validateEnv,
      cache: true,
    }),

    /**
     * Global rate limit. Individual routes override it: webhooks get a much
     * higher ceiling (Stripe bursts after an outage), order creation a much
     * lower one (it writes to the DB and calls Stripe).
     *
     * The Redis storage is not optional. The default in-memory counter is PER
     * PROCESS, so three API replicas behind the load balancer would each allow the
     * full limit — a "10 orders per minute" rule silently becomes 30, and the
     * protection you think you have scales away exactly as you scale up.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('RATE_LIMIT_TTL_SECONDS', 60) * 1000,
            limit: config.get<number>('RATE_LIMIT_MAX', 120),
          },
        ],
        storage: new ThrottlerStorageRedisService(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),

    ScheduleModule.forRoot(), // drives the Uber Direct retry queue

    PrismaModule,
    RedisModule,
    CommonModule,
    StorageModule,
    NotificationsModule,

    RestaurantsModule,
    MenuModule,
    OrdersModule,
    PaymentsModule,
    DeliveryModule,
    QrModule,
    StorefrontModule,
    WidgetModule,
    AnalyticsModule,
    CustomersModule,
    AdminModule,
    DomainsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
