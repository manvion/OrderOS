import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { MenuModule } from '../menu/menu.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CateringController } from './catering.controller';
import { CateringPublicController } from './catering-public.controller';
import { CateringService } from './catering.service';

@Module({
  // PaymentsService opens the Stripe checkout for paid packages; MenuModule's
  // importer writes package descriptions from the real menu; NotificationsModule
  // alerts the restaurant when an enquiry lands.
  imports: [PaymentsModule, MenuModule, NotificationsModule],
  controllers: [CateringController, CateringPublicController],
  providers: [CateringService],
  exports: [CateringService],
})
export class CateringModule {}
