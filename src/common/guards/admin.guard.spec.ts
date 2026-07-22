import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../../prisma/prisma.service';

const ADMIN_MSG = 'This action requires an administrator account.';

/** Builds a minimal ExecutionContext whose HTTP request carries `user`. */
function buildContext(user?: { id: string }): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    guard = new AdminGuard(prisma as unknown as PrismaService);
  });

  it('allows an admin user through', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(
      guard.canActivate(buildContext({ id: 'u-admin' })),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u-admin' },
      select: { isAdmin: true },
    });
  });

  it('forbids a non-admin user', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: false });

    await expect(
      guard.canActivate(buildContext({ id: 'u-plain' })),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      guard.canActivate(buildContext({ id: 'u-plain' })),
    ).rejects.toThrow(ADMIN_MSG);
  });

  it('forbids when the user row no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      guard.canActivate(buildContext({ id: 'u-gone' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('forbids (without a db lookup) when the request carries no user', async () => {
    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
