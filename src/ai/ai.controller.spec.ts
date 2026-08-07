import { Test, TestingModule } from '@nestjs/testing';
import { AiController } from './ai.controller';
import { AiService, LocationContext, RouteCheckResult } from './ai.service';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../resources/trip/trips.service';
import type { AuthenticatedUser } from '../common/types/auth.types';

describe('AiController', () => {
  let controller: AiController;
  let aiService: {
    reverseGeocode: jest.Mock;
    routeCheck: jest.Mock;
  };
  let tripsService: { getTrip: jest.Mock };
  let prismaService: { $queryRaw: jest.Mock };

  const MOCK_USER: AuthenticatedUser = {
    id: 'user-1',
    email: 'test@test.com',
  };

  beforeEach(async () => {
    aiService = {
      reverseGeocode: jest.fn().mockResolvedValue(null),
      routeCheck: jest.fn(),
    };

    tripsService = {
      getTrip: jest.fn(),
    };

    prismaService = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: aiService },
        { provide: TripsService, useValue: tripsService },
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  describe('POST /ai/route-check', () => {
    const body = {
      originLat: 6.5244,
      originLng: 3.3792,
      destLat: 6.5975,
      destLng: 3.3421,
      mode: 'CAR' as const,
    };

    it('calls AiService.routeCheck with structured context', async () => {
      const originCtx: LocationContext = {
        address: 'Lagos Island',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        postalCode: null,
        landmark: null,
      };
      const destCtx: LocationContext = {
        address: 'Ikeja',
        city: 'Ikeja',
        state: 'Lagos',
        country: 'Nigeria',
        postalCode: null,
        landmark: null,
      };

      aiService.reverseGeocode.mockResolvedValueOnce(originCtx);
      aiService.reverseGeocode.mockResolvedValueOnce(destCtx);

      aiService.routeCheck.mockResolvedValueOnce({
        riskLevel: 'LOW',
        incidentCount: 0,
        advisories: [],
        summary: 'Clear route',
      } satisfies RouteCheckResult);

      const result = await controller.routeCheck(MOCK_USER, body);

      expect(result.riskLevel).toBe('LOW');
      expect(aiService.routeCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'CAR',
          distanceKm: expect.any(Number) as number,
          incidents: expect.any(Array) as unknown[],
        }),
      );
    });

    it('queries incidents along the route corridor', async () => {
      aiService.routeCheck.mockResolvedValueOnce({
        riskLevel: 'LOW',
        incidentCount: 0,
        advisories: [],
        summary: 'Clear route',
      });

      await controller.routeCheck(MOCK_USER, body);

      expect(prismaService.$queryRaw).toHaveBeenCalled();
    });

    it('handles zero incidents gracefully', async () => {
      aiService.routeCheck.mockResolvedValueOnce({
        riskLevel: 'LOW',
        incidentCount: 0,
        advisories: ['No hazards ahead — safe travels'],
        summary: 'Route is clear of reported incidents.',
      });

      const result = await controller.routeCheck(MOCK_USER, body);

      expect(result.incidentCount).toBe(0);
      expect(result.advisories).toHaveLength(1);
    });
  });
});
