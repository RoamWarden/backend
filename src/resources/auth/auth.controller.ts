import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { UsersService } from '../user/users.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { HandoffDto } from './dto/handoff.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService } from './email-verification.service';
import { GoogleAuthService } from './google-auth.service';
import { HandoffTokenService } from './handoff-token.service';
import { PasswordAuthService } from './password-auth.service';
import { TokensService } from './tokens.service';
import type {
  AuthSession,
  AuthTokenPair,
  PendingVerification,
} from './type/auth.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly tokensService: TokensService,
    private readonly usersService: UsersService,
    private readonly passwordAuthService: PasswordAuthService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly handoffTokenService: HandoffTokenService,
  ) {}

  /**
   * Google Sign-In for the app AND the website.
   *
   * `allowSignup` is forwarded verbatim: the default (undefined → true) lives in
   * UsersService so exactly one place decides it. The app sends only `idToken`
   * and keeps creating an account on first sign-in; the website sends `false`,
   * which turns an unknown identity into a 404 `{ code: 'NO_ACCOUNT' }` with
   * nothing written. An identity that resolves to an existing account signs in
   * in both modes.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 900000 } })
  @Post('google')
  async google(@Body() dto: GoogleAuthDto): Promise<AuthSession> {
    const profile = await this.googleAuthService.verify(dto.idToken);
    const user = await this.usersService.upsertFromGoogle(profile, {
      allowSignup: dto.allowSignup,
    });
    return this.tokensService.issueSession(user);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 900000 } })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { accessToken, refreshToken } =
      await this.tokensService.rotateRefreshToken(dto.refreshToken);
    return { accessToken, refreshToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.tokensService.revokeRefreshToken(dto.refreshToken);
  }

  /**
   * App → web account hand-off (build plan §20). The web account page swaps the
   * single-use token from its URL for a normal session, exactly like login. The
   * token is burned on redemption, so a leaked URL can't be replayed. Public by
   * necessity — the browser has no session yet — and throttled like /auth/refresh.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 900000 } })
  @Post('handoff')
  @HttpCode(HttpStatus.OK)
  handoff(@Body() dto: HandoffDto): Promise<AuthSession> {
    return this.handoffTokenService.exchange(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<PendingVerification> {
    return this.passwordAuthService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 900000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<AuthSession> {
    return this.emailVerificationService.verify(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<{ message: string }> {
    return this.emailVerificationService.resend(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('login')
  login(@Body() dto: LoginDto): Promise<AuthSession> {
    return this.passwordAuthService.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    return this.passwordAuthService.forgotPassword(dto);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    return this.passwordAuthService.resetPassword(dto);
  }

  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<AuthTokenPair> {
    return this.passwordAuthService.changePassword(user.id, dto);
  }
}
