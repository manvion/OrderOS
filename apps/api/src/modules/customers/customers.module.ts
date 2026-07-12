import { Module } from '@nestjs/common';
import { CustomerAccountService } from './customer-account.service';
import { AuditController, CustomersController } from './customers.controller';

@Module({
  controllers: [CustomersController, AuditController],
  providers: [CustomerAccountService],
  // The storefront uses this for customer accounts and saved addresses.
  exports: [CustomerAccountService],
})
export class CustomersModule {}
