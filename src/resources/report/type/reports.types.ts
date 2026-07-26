import type { ReportStatus, ReportType } from '@prisma/client';

/** Public anonymized report shape; reporter identity is intentionally absent. */
export interface ReportView {
  id: string;
  type: ReportType;
  status: ReportStatus;
  lat: number;
  lng: number;
  note: string | null;
  confirmCount: number;
  denyCount: number;
  createdAt: Date;
  expiresAt: Date;
  /**
   * "You filed this one" — computed per request against the CALLER, never a
   * reporter id. It is the entire authorship signal a client gets, and that is
   * the point: the app needs to know which pin carries its own retract button
   * and nothing else. Shipping `reporterId` would deanonymise every report on
   * the map for the sake of one button (privacy §17).
   */
  mine: boolean;
}

export interface CreateReportInput {
  type: ReportType;
  lat: number;
  lng: number;
  note?: string;
}

/** Raw geo-query row, aliased to camelCase by the query. */
export type ReportRow = ReportView;
