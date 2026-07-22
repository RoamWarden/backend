import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { UsersService } from '../user/users.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { GoogleAuthService } from './google-auth.service';
import { PasswordAuthService } from './password-auth.service';
import { TokensService } from './tokens.service';
import type { AuthSession, AuthTokenPair } from './type/auth.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly tokensService: TokensService,
    private readonly usersService: UsersService,
    private readonly passwordAuthService: PasswordAuthService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 900000 } })
  @Post('google')
  async google(@Body() dto: GoogleAuthDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      reputation: number;
    };
  }> {
    const profile = await this.googleAuthService.verify(dto.idToken);
    const user = await this.usersService.upsertFromGoogle(profile);
    const accessToken = this.tokensService.signAccessToken({
      id: user.id,
      email: user.email,
    });
    const { token: refreshToken } = await this.tokensService.issueRefreshToken(
      user.id,
    );
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        reputation: user.reputation,
      },
    };
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

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<AuthSession> {
    return this.passwordAuthService.register(dto);
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
