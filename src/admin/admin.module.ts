import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminController, AdminLoginController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [AdminLoginController, AdminController],
  providers: [AdminAuthService, AdminGuard, AdminService],
})
export class AdminModule {}
