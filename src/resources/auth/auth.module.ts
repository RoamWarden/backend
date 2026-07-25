import { Module } from '@nestjs/common';
import { MailModule } from '../../providers/mail/mail.module';
import { UsersModule } from '../user/users.module';
import { AuthController } from './auth.controller';
import { EmailVerificationService } from './email-verification.service';
import { GoogleAuthService } from './google-auth.service';
import { HandoffTokenService } from './handoff-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordAuthService } from './password-auth.service';
import { TokensService } from './tokens.service';
import { TripShareTokenService } from './trip-share-token.service';

/**
 * HandoffTokenService is exported so BillingModule can mint the app→web account
 * link. Session minting itself stays in here — no other module issues tokens.
 */
@Module({
  imports: [UsersModule, MailModule],
  controllers: [AuthController],
  providers: [
    GoogleAuthService,
    TokensService,
    TripShareTokenService,
    JwtAuthGuard,
    PasswordAuthService,
    EmailVerificationService,
    HandoffTokenService,
  ],
  exports: [
    TokensService,
    TripShareTokenService,
    JwtAuthGuard,
    HandoffTokenService,
  ],
})
export class AuthModule {}
