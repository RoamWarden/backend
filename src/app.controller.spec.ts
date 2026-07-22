import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './providers/redis/redis.service';

describe('AppController', () => {
  let appController: AppController;
  let prismaMock: { $queryRaw: jest.Mock };
  let redisMock: { client: { ping: jest.Mock } };

  beforeEach(async () => {
    prismaMock = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    redisMock = { client: { ping: jest.fn().mockResolvedValue('PONG') } };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
      ],
    }).compile();

    appController = app.get(AppController);
  });

  describe('root', () => {
    it('should return the service banner', () => {
      expect(appController.getHello()).toBe('RoamWarden API');
    });
  });

  describe('health', () => {
    it('reports ok when database and redis are reachable', async () => {
      const health = await appController.getHealth();
      expect(health.status).toBe('ok');
      expect(health.service).toBe('roamwarden-api');
      expect(health.checks).toEqual({ database: 'up', redis: 'up' });
      expect(typeof health.timestamp).toBe('string');
    });

    it('reports degraded when the database is down', async () => {
      prismaMock.$queryRaw.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );
      const health = await appController.getHealth();
      expect(health.status).toBe('degraded');
      expect(health.checks.database).toBe('down');
      expect(health.checks.redis).toBe('up');
    });

    it('reports degraded when redis is down', async () => {
      redisMock.client.ping.mockRejectedValueOnce(new Error('connection lost'));
      const health = await appController.getHealth();
      expect(health.status).toBe('degraded');
      expect(health.checks.redis).toBe('down');
      expect(health.checks.database).toBe('up');
    });
  });
});
