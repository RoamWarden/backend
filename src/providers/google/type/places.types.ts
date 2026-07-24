/** A named place as exposed to the app (map picker list + search box). */
export interface Place {
  /** Google `place_id`. */
  id: string;
  name: string;
  /** `vicinity ?? formatted_address ?? ''` from the Google result. */
  address: string;
  lat: number;
  lng: number;
  types: string[];
}

/** Raw shape shared by the Nearby Search and Text Search JSON endpoints. */
export interface GooglePlacesResponse {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    name?: string;
    vicinity?: string;
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    types?: string[];
  }>;
}
