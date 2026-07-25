import type { ConfigService } from '@nestjs/config';

/**
 * The public live-view link sent to trusted contacts. Mirrors the private
 * builder in TripsService; lives here so the SOS raise path and the escalation
 * ladder cannot drift apart on the URL they hand out.
 *
 * The token is re-issued per send rather than stored: a share token expires, so
 * an escalation twenty minutes later must mint a fresh one or the contact gets
 * a dead link at the worst possible moment.
 */
export function buildTripShareUrl(
  config: ConfigService,
  tripId: string,
  token: string,
): string {
  const port = config.get<string | number>('PORT') ?? 3000;
  const base = config.get<string>('API_BASE_URL') ?? `http://localhost:${port}`;
  return `${base.replace(/\/+$/, '')}/trips/${tripId}/live?token=${encodeURIComponent(token)}`;
}
