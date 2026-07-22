import { Module } from '@nestjs/common';
import { MailModule } from '../../providers/mail/mail.module';
import { UsersModule } from '../user/users.module';
import { AuthController } from './auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordAuthService } from './password-auth.service';
import { TokensService } from './tokens.service';
import { TripShareTokenService } from './trip-share-token.service';

@Module({
  imports: [UsersModule, MailModule],
  controllers: [AuthController],
  providers: [
    GoogleAuthService,
    TokensService,
    TripShareTokenService,
    JwtAuthGuard,
    PasswordAuthService,
  ],
  exports: [TokensService, TripShareTokenService, JwtAuthGuard],
})
export class AuthModule {}
