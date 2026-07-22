import { Controller, Get, Logger } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './providers/redis/redis.service';

type DependencyStatus = 'up' | 'down';

interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  timestamp: string;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  getHello(): string {
    return 'RoamWarden API';
  }

  @Public()
  @Get('health')
  async getHealth(): Promise<HealthReport> {
    let database: DependencyStatus = 'up';
    let redis: DependencyStatus = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = 'down';
      this.logger.error('Health check: database is unreachable', error);
    }

    try {
      await this.redis.client.ping();
    } catch (error) {
      redis = 'down';
      this.logger.error('Health check: redis is unreachable', error);
    }

    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      service: 'roamwarden-api',
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    };
  }
}
