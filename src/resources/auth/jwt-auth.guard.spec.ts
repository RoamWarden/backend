import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokensService } from './tokens.service';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string; email: string };
}

/** Builds a minimal ExecutionContext exposing the handler/class + request. */
function makeContext(request: FakeRequest): ExecutionContext {
  const handler = () => undefined;
  class FakeController {}
  return {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflectorMock: { getAllAndOverride: jest.Mock };
  let tokensMock: { verifyAccessToken: jest.Mock };

  beforeEach(async () => {
    reflectorMock = { getAllAndOverride: jest.fn() };
    tokensMock = { verifyAccessToken: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: reflectorMock },
        { provide: TokensService, useValue: tokensMock },
      ],
    }).compile();

    guard = moduleRef.get(JwtAuthGuard);
  });

  it('bypasses auth for @Public() routes without requiring a token', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const request: FakeRequest = { headers: {} };
    const context = makeContext(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(reflectorMock.getAllAndOverride).toHaveBeenCalledWith(
      IS_PUBLIC_KEY,
      expect.any(Array),
    );
    expect(tokensMock.verifyAccessToken).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('throws 401 with the sign-in message when the Authorization header is missing', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(false);
    const context = makeContext({ headers: {} });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(
      'You must be signed in to do this.',
    );
    expect(tokensMock.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('throws 401 for a malformed header without a Bearer scheme', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(false);
    const context = makeContext({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(
      'You must be signed in to do this.',
    );
    expect(tokensMock.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('sets request.user from the verified payload on a valid bearer token', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(false);
    tokensMock.verifyAccessToken.mockReturnValue({
      sub: 'user-42',
      email: 'traveller@example.com',
      type: 'access',
    });
    const request: FakeRequest = {
      headers: { authorization: 'Bearer good.access.token' },
    };
    const context = makeContext(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(tokensMock.verifyAccessToken).toHaveBeenCalledWith(
      'good.access.token',
    );
    expect(request.user).toEqual({
      id: 'user-42',
      email: 'traveller@example.com',
    });
  });

  it('accepts a lowercase bearer scheme (case-insensitive)', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(false);
    tokensMock.verifyAccessToken.mockReturnValue({
      sub: 'user-7',
      email: 'lower@example.com',
      type: 'access',
    });
    const request: FakeRequest = {
      headers: { authorization: 'bearer good.token' },
    };
    const context = makeContext(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(tokensMock.verifyAccessToken).toHaveBeenCalledWith('good.token');
    expect(request.user).toEqual({ id: 'user-7', email: 'lower@example.com' });
  });

  it('propagates the UnauthorizedException thrown by an invalid token', () => {
    reflectorMock.getAllAndOverride.mockReturnValue(false);
    tokensMock.verifyAccessToken.mockImplementation(() => {
      throw new UnauthorizedException(
        'Your session token is invalid — please sign in again.',
      );
    });
    const context = makeContext({
      headers: { authorization: 'Bearer tampered.token' },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(
      'Your session token is invalid — please sign in again.',
    );
  });
});
