import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
  let service: AiService;
  let configGet: jest.Mock;

  const MOCK_API_KEY = 'gsk_test123';

  beforeEach(async () => {
    configGet = jest.fn().mockReturnValue(MOCK_API_KEY);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  // ── routeCheck ──────────────────────────────────────────────────────────

  describe('routeCheck', () => {
    const mockContext = {
      mode: 'CAR',
      originLabel: 'Lagos Island',
      destLabel: 'Ikeja',
      originContext: {
        address: 'Lagos Island, Nigeria',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
        postalCode: null,
        landmark: null,
      },
      destContext: {
        address: 'Ikeja, Nigeria',
        city: 'Ikeja',
        state: 'Lagos',
        country: 'Nigeria',
        postalCode: null,
        landmark: null,
      },
      distanceKm: 28.5,
      estimatedDurationMin: 45,
      incidents: [
        {
          type: 'POTHOLE',
          severity: 'HIGH',
          distanceKm: 5.2,
          note: 'Deep pothole near roundabout',
        },
        {
          type: 'TRAFFIC',
          severity: 'MEDIUM',
          distanceKm: 12.0,
          note: 'Heavy congestion reported',
        },
      ],
    };

    const mockSchemaResponse = {
      riskLevel: 'MEDIUM',
      incidentCount: 2,
      advisories: [
        'Slow down near the roundabout at 5.2km',
        'Expect 10-min delay from traffic at 12km',
      ],
      summary:
        'Moderate risk on this 28.5km route. Two incidents ahead — a deep pothole and heavy traffic.',
    };

    function mockFetchOk(body: unknown): void {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => {
          await Promise.resolve();
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(body),
                  refusal: null,
                },
              },
            ],
          } as unknown;
        },
      } as Response);
    }

    it('returns structured route advisory on success', async () => {
      mockFetchOk(mockSchemaResponse);

      const result = await service.routeCheck(mockContext);

      expect(result).toEqual(mockSchemaResponse);
    });

    it('throws when GROQ_API_KEY is not configured', async () => {
      configGet.mockReturnValueOnce(undefined);

      await expect(service.routeCheck(mockContext)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws when Groq refuses the request', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => {
          await Promise.resolve();
          return {
            choices: [
              {
                message: {
                  content: null,
                  refusal: 'Content policy violation',
                },
              },
            ],
          } as unknown;
        },
      } as Response);

      await expect(service.routeCheck(mockContext)).rejects.toThrow(
        'Groq refused route check: Content policy violation',
      );
    });

    it('throws when Groq API returns non-ok status', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      } as Response);

      await expect(service.routeCheck(mockContext)).rejects.toThrow(
        'Groq chat failed: 429 Too Many Requests',
      );
    });

    it('returns LOW risk when no incidents found', async () => {
      const noIncidentsContext = { ...mockContext, incidents: [] };
      const lowRiskResponse = {
        riskLevel: 'LOW',
        incidentCount: 0,
        advisories: ['No incidents reported — route looks clear'],
        summary: 'This route appears safe with no reported incidents.',
      };

      mockFetchOk(lowRiskResponse);

      const result = await service.routeCheck(noIncidentsContext);
      expect(result.riskLevel).toBe('LOW');
      expect(result.incidentCount).toBe(0);
    });
  });
});
