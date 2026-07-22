import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { RealtimeGateway } from './realtime.gateway';
import { TokensService } from '../auth/tokens.service';
import { TripShareTokenService } from '../auth/trip-share-token.service';
import { RedisService } from '../../providers/redis/redis.service';
import { TripsService } from '../trip/trips.service';
import { tripRoom, userRoom } from './constant/realtime.constants';

type SocketMock = {
  id: string;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
};

function makeSocket(auth: Record<string, unknown> = {}): SocketMock {
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth, headers: {} },
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;
  let tokensMock: { verifyAccessToken: jest.Mock };
  let tripsMock: {
    getTripOwnerId: jest.Mock;
    getWatcherUserIds: jest.Mock;
    isValidShareToken: jest.Mock;
  };
  let redisMock: {
    markSocketConnected: jest.Mock;
    markSocketDisconnected: jest.Mock;
    updatePresence: jest.Mock;
    createSubscriber: jest.Mock;
  };

  beforeEach(async () => {
    tokensMock = { verifyAccessToken: jest.fn() };
    tripsMock = {
      getTripOwnerId: jest.fn(),
      getWatcherUserIds: jest.fn(),
      isValidShareToken: jest.fn(),
    };
    redisMock = {
      markSocketConnected: jest.fn().mockResolvedValue(undefined),
      markSocketDisconnected: jest.fn().mockResolvedValue(undefined),
      updatePresence: jest.fn().mockResolvedValue(undefined),
      createSubscriber: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RedisService, useValue: redisMock },
        { provide: TokensService, useValue: tokensMock },
        {
          provide: TripShareTokenService,
          useValue: { issue: jest.fn(), verify: jest.fn() },
        },
        { provide: TripsService, useValue: tripsMock },
      ],
    }).compile();

    gateway = moduleRef.get(RealtimeGateway);
    // Silence the Logger noise from expected error paths.
    jest.spyOn(gateway['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('handleConnection', () => {
    it('rejects a socket with an invalid token: emits error and disconnects', async () => {
      tokensMock.verifyAccessToken.mockImplementation(() => {
        throw new Error('bad token');
      });
      const socket = makeSocket({ token: 'garbage' });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.emit).toHaveBeenCalledWith('error', {
        message:
          'Your session is invalid or expired — reconnect with a fresh token.',
      });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.data.user).toBeUndefined();
      expect(redisMock.markSocketConnected).not.toHaveBeenCalled();
    });

    it('rejects a socket with no token at all', async () => {
      const socket = makeSocket({});

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.emit).toHaveBeenCalledWith('error', {
        message:
          'Your session is invalid or expired — reconnect with a fresh token.',
      });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(tokensMock.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('accepts a valid token: sets socket.data.user, joins user room, marks connected', async () => {
      tokensMock.verifyAccessToken.mockReturnValue({
        sub: 'user-1',
        email: 'a@b.com',
      });
      const socket = makeSocket({ token: 'good' });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.data.user).toEqual({ id: 'user-1', email: 'a@b.com' });
      expect(socket.join).toHaveBeenCalledWith(userRoom('user-1'));
      expect(redisMock.markSocketConnected).toHaveBeenCalledWith('user-1');
      expect(socket.data.presenceTracked).toBe(true);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('accepts a Bearer token from the Authorization header', async () => {
      tokensMock.verifyAccessToken.mockReturnValue({
        sub: 'user-2',
        email: 'c@d.com',
      });
      const socket = makeSocket({});
      socket.handshake.headers.authorization = 'Bearer header-token';

      await gateway.handleConnection(socket as unknown as Socket);

      expect(tokensMock.verifyAccessToken).toHaveBeenCalledWith('header-token');
      expect(socket.data.user).toEqual({ id: 'user-2', email: 'c@d.com' });
    });

    it('keeps the socket usable when presence tracking fails', async () => {
      tokensMock.verifyAccessToken.mockReturnValue({
        sub: 'user-1',
        email: 'a@b.com',
      });
      redisMock.markSocketConnected.mockRejectedValueOnce(
        new Error('redis down'),
      );
      const socket = makeSocket({ token: 'good' });

      await gateway.handleConnection(socket as unknown as Socket);

      expect(socket.data.user).toEqual({ id: 'user-1', email: 'a@b.com' });
      expect(socket.data.presenceTracked).toBeUndefined();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('trip:subscribe access control', () => {
    it('grants the trip owner', async () => {
      tripsMock.getTripOwnerId.mockResolvedValue('user-1');
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
      });

      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(tripRoom('trip-1'));
      expect(tripsMock.getWatcherUserIds).not.toHaveBeenCalled();
    });

    it('grants a linked watcher of the trip', async () => {
      tripsMock.getTripOwnerId.mockResolvedValue('owner-9');
      tripsMock.getWatcherUserIds.mockResolvedValue(['user-1', 'user-2']);
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
      });

      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(tripRoom('trip-1'));
    });

    it('denies a non-watcher with no share token, with the access-denied message', async () => {
      tripsMock.getTripOwnerId.mockResolvedValue('owner-9');
      tripsMock.getWatcherUserIds.mockResolvedValue(['someone-else']);
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
      });

      expect(ack).toEqual({
        ok: false,
        error: 'You do not have access to this trip.',
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('grants access via a VALID share token (isValidShareToken === true)', async () => {
      tripsMock.getTripOwnerId.mockResolvedValue('owner-9');
      tripsMock.getWatcherUserIds.mockResolvedValue(['someone-else']);
      tripsMock.isValidShareToken.mockResolvedValue(true);
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
        shareToken: 'valid-share',
      });

      expect(tripsMock.isValidShareToken).toHaveBeenCalledWith(
        'trip-1',
        'valid-share',
      );
      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(tripRoom('trip-1'));
    });

    it('denies when the share token is invalid (isValidShareToken === false)', async () => {
      tripsMock.getTripOwnerId.mockResolvedValue('owner-9');
      tripsMock.getWatcherUserIds.mockResolvedValue(['someone-else']);
      tripsMock.isValidShareToken.mockResolvedValue(false);
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
        shareToken: 'stale-share',
      });

      expect(ack).toEqual({
        ok: false,
        error: 'You do not have access to this trip.',
      });
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('grants an unauthenticated socket that presents a valid share token', async () => {
      tripsMock.isValidShareToken.mockResolvedValue(true);
      const socket = makeSocket(); // no socket.data.user

      const ack = await gateway.onTripSubscribe(socket as unknown as Socket, {
        tripId: 'trip-1',
        shareToken: 'valid-share',
      });

      // Owner lookup is skipped for anonymous sockets.
      expect(tripsMock.getTripOwnerId).not.toHaveBeenCalled();
      expect(tripsMock.isValidShareToken).toHaveBeenCalledWith(
        'trip-1',
        'valid-share',
      );
      expect(ack).toEqual({ ok: true });
      expect(socket.join).toHaveBeenCalledWith(tripRoom('trip-1'));
    });

    it('rejects a malformed subscribe payload before touching TripsService', async () => {
      const socket = makeSocket();
      socket.data.user = { id: 'user-1', email: 'a@b.com' };

      const ack = await gateway.onTripSubscribe(
        socket as unknown as Socket,
        {},
      );

      expect(ack).toEqual({
        ok: false,
        error: 'tripId is required — send the id of the trip to watch.',
      });
      expect(tripsMock.getTripOwnerId).not.toHaveBeenCalled();
    });
  });
});
