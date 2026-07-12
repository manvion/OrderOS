import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Public, TenantId } from '../../common/auth/decorators';
import { NotificationsService } from './notifications.service';
import { SmsService } from './sms.service';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(ClerkAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * "The customer says they never got the text."
   *
   * Every message we attempted for an order — sent, failed, or deliberately
   * skipped — with the provider's id so support can trace it into Twilio. Before
   * this existed, the only honest answer to that question was a shrug.
   */
  @Get('orders/:orderId')
  listForOrder(@TenantId() restaurantId: string, @Param('orderId') orderId: string) {
    return this.notifications.listForOrder(restaurantId, orderId);
  }

  /**
   * Twilio posts here when a customer replies to one of our texts — almost always
   * to say STOP.
   *
   * @Public because Twilio has no session, but NOT unauthenticated: the request is
   * authenticated by Twilio's HMAC signature over the URL and form body. Without
   * that check, anyone could POST `From=<victim>&Body=STOP` and silently
   * unsubscribe a stranger from updates about their own dinner.
   *
   * Responds with TwiML, which is what Twilio expects.
   */
  @Post('sms-inbound')
  @Public()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  async inboundSms(
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Body() body: Record<string, string>,
  ): Promise<string> {
    // Twilio signs the exact public URL it called, which is not necessarily the
    // one Express sees behind a load balancer — so reconstruct it from config.
    const url = `${this.config.getOrThrow<string>('API_URL')}/api/notifications/sms-inbound`;

    if (!this.sms.verifyWebhookSignature(url, body, signature)) {
      throw new ForbiddenException('Invalid Twilio signature');
    }

    const { reply } = await this.notifications.handleInboundSms(
      body.From ?? '',
      body.Body ?? '',
    );

    // Empty TwiML = "we received it, send nothing back". Correct for STOP, since
    // Twilio already sends the carrier-mandated confirmation itself and a second
    // message would be texting someone who just asked us to stop.
    return reply
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
