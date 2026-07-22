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
}

export interface CreateReportInput {
  type: ReportType;
  lat: number;
  lng: number;
  note?: string;
}

/** Raw geo-query row, aliased to camelCase by the query. */
export type ReportRow = ReportView;
