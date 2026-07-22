export interface SosRaisedMessage {
  sosId: string;
  user: { id: string; name: string };
  tripId?: string;
  lat?: number;
  lng?: number;
  message?: string;
  contactUserIds: string[];
  raisedAt: string;
}

export interface RaiseSosResult {
  sosId: string;
  notifiedContactCount: number;
  shareUrl?: string;
  warning?: string;
}
