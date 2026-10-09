import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { MemberAuthService } from './member-auth.service.js';
import { MemberEmailService } from './member-email.service.js';
import { MemberOrdersService } from './member-orders.service.js';
import { MembersController } from './members.controller.js';

@Module({
  imports: [PrismaModule, PaymentsModule],
  providers: [MemberAuthService, MemberEmailService, MemberOrdersService],
  controllers: [MembersController],
})
export class MembersModule {}
