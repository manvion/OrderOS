import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * Marketing leads (book-a-demo / done-for-you setup). Exports LeadsService so the
 * admin module can list and work the pipeline; the controller here is only the
 * public submit endpoint.
 */
@Module({
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
