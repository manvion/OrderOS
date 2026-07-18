import { Module } from '@nestjs/common';
import { PromotionsModule } from '../promotions/promotions.module';
import { MenuController } from './menu.controller';
import { MenuImportService } from './menu-import.service';
import { MenuService } from './menu.service';

@Module({
  imports: [PromotionsModule],
  controllers: [MenuController],
  providers: [MenuService, MenuImportService],
  exports: [MenuService, MenuImportService],
})
export class MenuModule {}
