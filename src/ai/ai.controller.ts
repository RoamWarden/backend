import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from '../resources/trip/trips.service';
import { AiService, RouteCheckResult, TripRecapResult } from './ai.service';

interface AiIncidentSubmission {
  voiceNote?: string; // base64 encoded audio
  voiceMimeType?: string;
  image?: string; // base64 encoded image
  note?: string;
  lat: number;
  lng: number;
  accuracy?: number;
}

interface AiRouteCheckBody {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  mode: string;
}

/** Corridor width in metres for incident search along the route path. */
const TRIP_RECAP_CORRIDOR_M = 500;
const ROUTE_CHECK_CORRIDOR_M = 300;

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly trips: TripsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * AI-assisted incident analysis endpoint.
   *
   * Accepts a voice note, photo, and/or text, then uses AI to:
   * 1. Transcribe voice to text (Groq Whisper)
   * 2. Analyze image for labels/context (Google Vision)
   * 3. Classify incident type/severity (Groq Chat)
   *
   * Returns classified incident data that can be used to pre-fill
   * the standard report creation form.
   */
  @Post('analyze-incident')
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async analyzeIncident(
    @CurrentUser() _user: AuthenticatedUser,
    @Body() submission: AiIncidentSubmission,
  ): Promise<{
    classification: Awaited<ReturnType<AiService['classifyIncident']>>;
    locationContext: Awaited<ReturnType<AiService['reverseGeocode']>> | null;
    transcript: string | null;
  }> {
    const { voiceNote, voiceMimeType, image, note, lat, lng } = submission;

    // Process voice note
    let transcript: string | null = null;
    if (voiceNote) {
      const result = await this.aiService.transcribeVoice(
        voiceNote,
        voiceMimeType || 'audio/m4a',
      );
      transcript = result.text;
    }

    // Analyze image
    let imageLabels: string[] = [];
    if (image) {
      const analysis = await this.aiService.analyzeImage(image);
      imageLabels = analysis.labels;
    }

    // Classify incident
    const classification = await this.aiService.classifyIncident({
      voiceText: transcript ?? undefined,
      imageLabels,
      userNote: note,
    });

    // Reverse geocode for location context
    const locationContext = await this.aiService.reverseGeocode(lat, lng);

    return { classification, locationContext, transcript };
  }

  /**
   * AI trip recap — generates a safety score and summary after trip completion.
   *
   * Fetches the completed trip, its route breadcrumbs, and community incidents
   * along the path. Passes structured data to the AI service which returns a
   * safety score (1-10), a narrative recap, and safety tips for the return trip.
   */
  @Post('trip-recap')
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  async tripRecap(
    @CurrentUser() user: AuthenticatedUser,
    @Body('tripId') tripId: string,
  ): Promise<TripRecapResult> {
    const { trip, route, points } = await this.trips.getTrip(user.id, tripId);

    // Query community incidents along the trip's route corridor.
    // Uses ST_DWithin between each report's geography point and the route's
    // LineString — returning reports within TRIP_RECAP_CORRIDOR_M of the path.
    let incidents: { type: string; severity: string; note: string | null }[] =
      [];
    if (route?.geojson) {
      const rows = await this.prisma.$queryRaw<
        { type: string; severity: string; note: string | null }[]
      >(Prisma.sql`
        SELECT r.type::text AS type,
               r.status::text AS severity,
               r.note
        FROM reports r
        JOIN trip_routes tr ON tr.trip_id = ${tripId}::uuid
        WHERE r.status IN ('UNCONFIRMED', 'VERIFIED')
          AND r.expires_at > now()
          AND ST_DWithin(
                r.geog,
                tr.path,
                ${TRIP_RECAP_CORRIDOR_M}
              )
        ORDER BY r.created_at DESC
        LIMIT 20
      `);
      incidents = rows;
    }

    // Calculate trip metrics
    const durationMinutes = trip.durationS
      ? Math.round(trip.durationS / 60)
      : 0;
    const distanceKm = this.estimateDistanceKm(points);

    // Resolve origin/destination area context
    const [originContext, destContext] = await Promise.all([
      this.aiService.reverseGeocode(trip.originLat, trip.originLng),
      this.aiService.reverseGeocode(trip.destLat, trip.destLng),
    ]);

    return this.aiService.tripRecap({
      mode: trip.mode,
      originLabel: trip.originLabel,
      destLabel: trip.destLabel,
      originContext,
      destContext,
      durationMinutes,
      distanceKm,
      pointCount: points.length,
      incidents,
    });
  }

  /**
   * Pre-trip route safety check — AI analyses a planned route for hazards.
   *
   * Queries community incidents along the straight-line corridor between origin
   * and destination, reverse-geocodes both endpoints, then passes structured
   * data to Groq for a risk level assessment with actionable driving advisories.
   */
  @Post('route-check')
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async routeCheck(
    @CurrentUser() _user: AuthenticatedUser,
    @Body() body: AiRouteCheckBody,
  ): Promise<RouteCheckResult> {
    const { originLat, originLng, destLat, destLng, mode } = body;

    // Query community incidents along the corridor.
    const wkt = `SRID=4326;LINESTRING(${originLng} ${originLat},${destLng} ${destLat})`;
    const rows = await this.prisma.$queryRaw<
      { type: string; severity: string; note: string | null }[]
    >(Prisma.sql`
      SELECT r.type::text AS type,
             r.status::text AS severity,
             r.note
      FROM reports r
      WHERE r.status IN ('UNCONFIRMED', 'VERIFIED')
        AND r.expires_at > now()
        AND ST_DWithin(
              r.geog,
              ST_GeogFromText(${wkt}),
              ${ROUTE_CHECK_CORRIDOR_M}
            )
      ORDER BY r.created_at DESC
      LIMIT 15
    `);

    const incidents = rows.map((r) => ({ ...r, distanceKm: 0 }));

    const distanceKm = haversineKm(originLat, originLng, destLat, destLng);
    const estimatedDurationMin = Math.round((distanceKm / 40) * 60);

    const [originContext, destContext] = await Promise.all([
      this.aiService.reverseGeocode(originLat, originLng),
      this.aiService.reverseGeocode(destLat, destLng),
    ]);

    return this.aiService.routeCheck({
      mode,
      originLabel: null,
      destLabel: null,
      originContext,
      destContext,
      distanceKm: Math.round(distanceKm * 10) / 10,
      estimatedDurationMin,
      incidents,
    });
  }

  /**
   * Estimate trip distance in km from consecutive breadcrumb points.
   * Uses the Haversine formula for accuracy. Falls back to 0 on empty input.
   */
  private estimateDistanceKm(points: { lat: number; lng: number }[]): number {
    if (points.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += haversineKm(
        points[i - 1].lat,
        points[i - 1].lng,
        points[i].lat,
        points[i].lng,
      );
    }
    return Math.round(total * 10) / 10;
  }
}

/** Haversine distance in kilometres between two lat/lng points. */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
