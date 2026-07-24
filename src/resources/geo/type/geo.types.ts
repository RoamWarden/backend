import type { Place } from '../../../providers/google/type/places.types';

/** Response shape for both /geo/places endpoints. */
export interface PlacesView {
  places: Place[];
  /**
   * True when the Google lookup was unavailable (no key / API failure) —
   * `places` is then always []. False with an empty `places` means Google
   * genuinely found nothing there.
   */
  degraded: boolean;
}
