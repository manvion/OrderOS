import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsPublicController } from './reservations-public.controller';
import { ReservationsService } from './reservations.service';

@Module({
  // NotificationsModule (EmailService) alerts the restaurant and confirms to the guest.
  imports: [NotificationsModule],
  controllers: [ReservationsController, ReservationsPublicController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
