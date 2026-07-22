import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../types/auth.types';
import { PrismaService } from '../../prisma/prisma.service';

interface RequestWithUser {
  user?: AuthenticatedUser;
}

/**
 * Per-route admin gate. Runs AFTER the global JwtAuthGuard, so request.user is
 * already populated. Loads the user and requires isAdmin. Applied explicitly
 * with @UseGuards(AdminGuard) — never registered globally.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.user?.id;
    if (!userId) {
      throw new ForbiddenException(
        'This action requires an administrator account.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    if (!user?.isAdmin) {
      throw new ForbiddenException(
        'This action requires an administrator account.',
      );
    }
    return true;
  }
}
