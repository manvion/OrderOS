import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { SmsService } from './sms.service';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [SmsService, EmailService, NotificationsService],
  exports: [SmsService, EmailService, NotificationsService],
})
export class NotificationsModule {}
