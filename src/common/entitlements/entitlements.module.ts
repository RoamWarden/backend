import { Global, Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';

/**
 * Plan entitlements (build plan §20).
 *
 * @Global on purpose: every feature module may eventually ask "what does this
 * user's plan include?", and a gate should never be skipped because someone
 * forgot an import. Inject `EntitlementsService` anywhere — no module changes
 * required. It depends only on PrismaModule and ConfigModule, both global.
 *
 * BillingModule imports it, which is what puts it in the graph; adding it to
 * app.module.ts as well is harmless (Nest instantiates a module class once).
 */
@Global()
@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
