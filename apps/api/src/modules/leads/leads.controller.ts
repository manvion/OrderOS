import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { LeadsService } from './leads.service';

const demoRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  restaurantName: z.string().max(160).optional(),
  city: z.string().max(120).optional(),
  message: z.string().max(2000).optional(),
  interest: z.string().max(60).optional(),
});

/**
 * The public "book a demo" endpoint. No session — it's on the marketing page, for
 * people who have not signed up. Rate-limited hard because an open POST that writes
 * a row is a spam magnet; 5/min per IP is plenty for a genuine enquiry.
 */
@ApiTags('leads')
@Controller('demo-requests')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Post()
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async submit(
    @Body(new ZodValidationPipe(demoRequestSchema)) body: z.infer<typeof demoRequestSchema>,
  ) {
    await this.leads.create(body);
    // Deliberately minimal: never echo back what we stored, and never reveal
    // whether this email has enquired before.
    return { received: true };
  }
}
