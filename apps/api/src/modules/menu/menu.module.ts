import { Module } from '@nestjs/common';
import { MenuController } from './menu.controller';
import { MenuImportService } from './menu-import.service';
import { MenuService } from './menu.service';

@Module({
  controllers: [MenuController],
  providers: [MenuService, MenuImportService],
  exports: [MenuService],
})
export class MenuModule {}
