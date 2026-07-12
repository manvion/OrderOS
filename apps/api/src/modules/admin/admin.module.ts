import { Module } from '@nestjs/common';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // Onboarding a restaurant on someone's behalf reuses the staff-invite flow: we
  // create the tenant, they claim ownership from their own inbox.
  imports: [RestaurantsModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
