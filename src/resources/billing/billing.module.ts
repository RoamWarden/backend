import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Subscription catalog + the caller's plan state (build plan §20). PrismaModule
 * is global; AuthModule supplies HandoffTokenService for the app→web account
 * hand-off. Exports BillingService so future feature gates can ask
 * `isPremium(userId)` instead of reading subscription rows themselves.
 */
@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
