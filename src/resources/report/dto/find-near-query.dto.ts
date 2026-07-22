import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';
import { REPORT_NEAR_MAX_RADIUS_M } from '../constant/reports.constants';

export class FindNearQueryDto {
  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lat query param must be a number (WGS84 latitude).' },
  )
  @Min(-90, { message: 'lat must be between -90 and 90.' })
  @Max(90, { message: 'lat must be between -90 and 90.' })
  lat!: number;

  @Type(() => Number)
  @IsNumber(
    {},
    { message: 'lng query param must be a number (WGS84 longitude).' },
  )
  @Min(-180, { message: 'lng must be between -180 and 180.' })
  @Max(180, { message: 'lng must be between -180 and 180.' })
  lng!: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'radiusM query param must be a number of metres.' })
  @Min(1, {
    message: `radiusM must be between 1 and ${REPORT_NEAR_MAX_RADIUS_M} metres.`,
  })
  @Max(REPORT_NEAR_MAX_RADIUS_M, {
    message: `radiusM must be between 1 and ${REPORT_NEAR_MAX_RADIUS_M} metres.`,
  })
  radiusM!: number;
}
