import { Module } from '@nestjs/common';
import { QrController, QrScanController } from './qr.controller';
import { QrService } from './qr.service';

@Module({
  controllers: [QrController, QrScanController],
  providers: [QrService],
  exports: [QrService],
})
export class QrModule {}
