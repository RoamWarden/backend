import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../../common/entitlements';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Subscription catalog + the caller's plan state (build plan §20). PrismaModule
 * is global; AuthModule supplies HandoffTokenService for the app→web account
 * hand-off. Exports BillingService so future feature gates can ask
 * `isPremium(userId)` instead of reading subscription rows themselves.
 *
 * Importing EntitlementsModule here is what puts it in the graph. It is
 * @Global, so every other module can inject EntitlementsService without
 * importing anything — a plan gate can never be missed over a forgotten import.
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService, EntitlementsModule],
})
export class BillingModule {}
