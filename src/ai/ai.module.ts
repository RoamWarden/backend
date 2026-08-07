import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { TripsModule } from '../resources/trip/trips.module';

/**
 * AI module — wraps external AI providers (Groq, Google Vision) behind a single
 * service so the rest of the app never touches provider SDKs directly.
 *
 * Providers are lazily initialised and individually optional: a missing API key
 * disables that capability and the service throws a clear error at call-time
 * rather than at bootstrap — so a misconfigured key doesn't take the whole
 * backend down.
 */
@Module({
  imports: [TripsModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
