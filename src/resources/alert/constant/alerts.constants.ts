import type { ReportType } from '@prisma/client';

/** Push-notification headline per report type. */
export const REPORT_TYPE_ALERT_TITLE: Record<ReportType, string> = {
  ROBBERY: 'Robbery reported near your route',
  HOLD_UP: 'Hold-up reported near your route',
  ACCIDENT: 'Accident reported near your route',
  CHECKPOINT: 'Checkpoint reported near your route',
  UNREST: 'Civil unrest reported near your route',
  BAD_ROAD: 'Bad road reported near your route',
  LOST_ITEM: 'Lost item reported near your route',
  OTHER: 'Incident reported near your route',
};

export const PUSH_BODY_MAX_CHARS = 100;
export const PUSH_BODY_FALLBACK = 'Tap to see details and plan around it.';
