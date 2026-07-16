import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // Onboarding a restaurant on someone's behalf reuses the staff-invite flow: we
  // create the tenant, they claim ownership from their own inbox. SubscriptionsModule
  // lets an admin comp a restaurant onto a paid plan; LeadsModule surfaces the
  // book-a-demo pipeline on the admin panel.
  imports: [RestaurantsModule, SubscriptionsModule, LeadsModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
