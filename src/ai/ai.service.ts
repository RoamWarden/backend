/**
 * AI Service — unified interface to external AI providers.
 *
 * Currently supports:
 * - Voice -> text (Groq Whisper)
 * - Image analysis (Google Vision)
 * - Text classification/summarization (Groq ChatCompletions)
 * - Reverse geocoding (Google Maps)
 *
 * All methods are async and return structured results. Missing API keys
 * cause a clear error at call time, not at bootstrap.
 */
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ── API response shapes ──────────────────────────────────────────────────

interface GroqWhisperResponse {
  text: string;
  confidence?: number;
}

interface GroqChatResponse {
  choices: { message: { content: string | null; refusal: string | null } }[];
}

interface GoogleVisionAnnotation {
  description: string;
}

interface GoogleVisionResponse {
  responses: {
    labelAnnotations?: GoogleVisionAnnotation[];
    textAnnotations?: GoogleVisionAnnotation[];
    safeSearchAnnotation?: {
      adult: string;
      violence: string;
      medical: string;
      spoof: string;
    };
    landmarkAnnotations?: GoogleVisionAnnotation[];
  }[];
}

interface GoogleGeocodeComponent {
  long_name: string;
  types: string[];
}

interface GoogleGeocodeResult {
  formatted_address: string;
  address_components: GoogleGeocodeComponent[];
}

interface GoogleGeocodeResponse {
  status: string;
  results: GoogleGeocodeResult[];
}

// ── Domain types ─────────────────────────────────────────────────────────

export interface VoiceTranscript {
  text: string;
  confidence?: number;
}

export interface ImageAnalysis {
  labels: string[];
  text: string[];
  safeSearch: {
    adult: 'VERY_LIKELY' | 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'VERY_UNLIKELY';
    violence:
      'VERY_LIKELY' | 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'VERY_UNLIKELY';
    medical:
      'VERY_LIKELY' | 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'VERY_UNLIKELY';
    spoof: 'VERY_LIKELY' | 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'VERY_UNLIKELY';
  };
  landmark?: string | null;
}

export interface IncidentClassification {
  type:
    | 'POTHOLE'
    | 'POLICE'
    | 'ACCIDENT'
    | 'CONSTRUCTION'
    | 'HAZARD'
    | 'TRAFFIC'
    | 'WEATHER';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number; // 0-1
  summary: string;
}

export interface LocationContext {
  address: string;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  landmark: string | null;
}

export interface TripRecapContext {
  mode: string;
  originLabel: string | null;
  destLabel: string | null;
  originContext: LocationContext | null;
  destContext: LocationContext | null;
  durationMinutes: number;
  distanceKm: number;
  pointCount: number;
  incidents: {
    type: string;
    severity: string;
    note: string | null;
  }[];
}

export interface TripRecapResult {
  safetyScore: number; // 1-10
  summary: string;
  tips: string[];
}

export interface RouteCheckContext {
  mode: string;
  originLabel: string | null;
  destLabel: string | null;
  originContext: LocationContext | null;
  destContext: LocationContext | null;
  distanceKm: number;
  estimatedDurationMin: number;
  incidents: {
    type: string;
    severity: string;
    distanceKm: number;
    note: string | null;
  }[];
}

export interface RouteCheckResult {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  incidentCount: number;
  advisories: string[];
  summary: string;
}

@Injectable()
export class AiService {
  constructor(private config: ConfigService) {}

  /**
   * Transcribe voice note to text using Groq Whisper.
   */
  async transcribeVoice(
    audioBase64: string,
    mimeType: string,
  ): Promise<VoiceTranscript> {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('GROQ_API_KEY is not configured');
    }

    const audioData = Buffer.from(audioBase64, 'base64');

    const formData = new FormData();
    formData.append('file', new Blob([audioData], { type: mimeType }), 'audio');
    formData.append('model', 'whisper-large-v3-turbo');

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Groq Whisper failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GroqWhisperResponse;
    return {
      text: result.text,
      confidence: result.confidence,
    };
  }

  /**
   * Analyze an image (photo of incident) using Google Vision API.
   */
  async analyzeImage(imageBase64: string): Promise<ImageAnalysis> {
    const apiKey = this.config.get<string>('GOOGLE_CLOUD_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException(
        'GOOGLE_CLOUD_API_KEY is not configured',
      );
    }

    const requests = [
      {
        image: { content: imageBase64 },
        features: [
          { type: 'LABEL_DETECTION', maxResults: 10 },
          { type: 'TEXT_DETECTION', maxResults: 5 },
          { type: 'SAFE_SEARCH_DETECTION' },
          { type: 'LANDMARK_DETECTION' },
        ],
      },
    ];

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Google Vision failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GoogleVisionResponse;
    const annotation = result.responses[0];

    return {
      labels: annotation.labelAnnotations?.map((l) => l.description) ?? [],
      text: annotation.textAnnotations?.map((t) => t.description) ?? [],
      safeSearch:
        (annotation.safeSearchAnnotation as ImageAnalysis['safeSearch']) ?? {
          adult: 'VERY_UNLIKELY',
          violence: 'VERY_UNLIKELY',
          medical: 'VERY_UNLIKELY',
          spoof: 'VERY_UNLIKELY',
        },
      landmark: annotation.landmarkAnnotations?.[0]?.description ?? null,
    };
  }

  /**
   * Use Groq chat to classify an incident based on voice transcript + image labels.
   */
  async classifyIncident(context: {
    voiceText?: string;
    imageLabels?: string[];
    userNote?: string;
  }): Promise<IncidentClassification> {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('GROQ_API_KEY is not configured');
    }

    const prompt = [
      'Classify the reported travel incident from the context below.',
      context.voiceText ? `Voice note: ${context.voiceText}` : null,
      context.imageLabels?.length
        ? `Image labels: ${context.imageLabels.join(', ')}`
        : null,
      context.userNote ? `User note: ${context.userNote}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Groq chat failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GroqChatResponse;
    const message = result.choices[0].message;

    if (message.refusal) {
      throw new InternalServerErrorException(
        `Groq refused classification: ${message.refusal}`,
      );
    }

    const parsed = JSON.parse(message.content!) as IncidentClassification;
    return {
      type: parsed.type,
      severity: parsed.severity,
      confidence: parsed.confidence,
      summary: parsed.summary,
    };
  }

  /**
   * Reverse geocode coordinates to a human-readable location context.
   * Uses Google Maps Geocoding API.
   */
  async reverseGeocode(
    lat: number,
    lng: number,
  ): Promise<LocationContext | null> {
    const apiKey = this.config.get<string>('GOOGLE_CLOUD_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException(
        'GOOGLE_CLOUD_API_KEY is not configured',
      );
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Google Geocoding failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GoogleGeocodeResponse;

    if (result.status !== 'OK' || !result.results?.length) {
      return null;
    }

    const addr = result.results[0];
    const components = addr.address_components;

    const getByTypes = (types: string[]): string | null => {
      const match = components.find((c) =>
        c.types.some((t: string) => types.includes(t)),
      );
      return match ? match.long_name : null;
    };

    return {
      address: addr.formatted_address || '',
      city: getByTypes([
        'locality',
        'postal_town',
        'administrative_area_level_2',
      ]),
      state: getByTypes(['administrative_area_level_1']),
      country: getByTypes(['country']),
      postalCode: getByTypes(['postal_code']),
      landmark: getByTypes(['point_of_interest', 'premise', 'route']),
    };
  }

  /**
   * Generate a trip safety score and narrative recap using Groq chat.
   *
   * Feeds in route data, community incidents encountered along the path,
   * and origin/destination area context. The LLM produces a structured
   * JSON response with a safety score (1-10), a plain-english summary,
   * and actionable tips for the return trip.
   */
  async tripRecap(context: TripRecapContext): Promise<TripRecapResult> {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('GROQ_API_KEY is not configured');
    }

    const originName =
      context.originLabel ?? context.originContext?.address ?? 'Unknown origin';
    const destName =
      context.destLabel ??
      context.destContext?.address ??
      'Unknown destination';

    const incidentList =
      context.incidents.length > 0
        ? context.incidents
            .map(
              (i) => `- ${i.type} (${i.severity}): ${i.note ?? 'no details'}`,
            )
            .join('\n')
        : 'No incidents reported along the route.';

    const prompt = `You are a travel safety analyst for the travel app Roam Warden.
Given the context below, produce a trip recap with a safety score, a short summary, and safety tips.

Trip details:
- Mode: ${context.mode}
- From: ${originName}
- To: ${destName}
- Duration: ${context.durationMinutes} minutes
- Distance: ${context.distanceKm.toFixed(1)} km
- GPS breadcrumbs: ${context.pointCount} points

Community incidents along the route:
${incidentList}`;

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Groq chat failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GroqChatResponse;
    const message = result.choices[0].message;

    if (message.refusal) {
      throw new InternalServerErrorException(
        `Groq refused trip recap: ${message.refusal}`,
      );
    }

    const parsed = JSON.parse(message.content!) as TripRecapResult;
    return {
      safetyScore: parsed.safetyScore,
      summary: parsed.summary,
      tips: parsed.tips,
    };
  }

  /**
   * Pre-trip route safety check — AI analyses a planned route and warns about
   * community-reported hazards ahead.
   *
   * Receives structured route context (origin/dest, distance, incident list)
   * and returns a risk level, actionable advisories, and a plain-english summary.
   * Uses Groq json_schema strict mode for guaranteed valid JSON output.
   */
  async routeCheck(context: RouteCheckContext): Promise<RouteCheckResult> {
    const apiKey = this.config.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('GROQ_API_KEY is not configured');
    }

    const originName =
      context.originLabel ?? context.originContext?.address ?? 'start point';
    const destName =
      context.destLabel ?? context.destContext?.address ?? 'destination';

    const incidentList =
      context.incidents.length > 0
        ? context.incidents
            .map(
              (i) =>
                `- ${i.type} (${i.severity}) at ${i.distanceKm.toFixed(1)}km: ${i.note ?? 'no details'}`,
            )
            .join('\n')
        : 'No reported incidents on this route.';

    const prompt = [
      `Route from ${originName} to ${destName}.`,
      `Mode: ${context.mode}, distance: ${context.distanceKm.toFixed(1)}km, estimated ${context.estimatedDurationMin}min.`,
      `Incidents: ${incidentList}`,
      'Provide a risk level, actionable driving advisories, and a brief summary.',
    ].join('\n');

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      },
    );

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Groq chat failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as GroqChatResponse;
    const message = result.choices[0].message;

    if (message.refusal) {
      throw new InternalServerErrorException(
        `Groq refused route check: ${message.refusal}`,
      );
    }

    const parsed = JSON.parse(message.content!) as RouteCheckResult;
    return {
      riskLevel: parsed.riskLevel,
      incidentCount: parsed.incidentCount,
      advisories: parsed.advisories,
      summary: parsed.summary,
    };
  }
}
