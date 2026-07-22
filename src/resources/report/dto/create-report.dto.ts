import { ReportType } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReportDto {
  @IsEnum(ReportType, {
    message: `type must be one of: ${Object.values(ReportType).join(', ')}.`,
  })
  type!: ReportType;

  @IsNumber({}, { message: 'lat must be a number (WGS84 latitude).' })
  @Min(-90, { message: 'lat must be between -90 and 90.' })
  @Max(90, { message: 'lat must be between -90 and 90.' })
  lat!: number;

  @IsNumber({}, { message: 'lng must be a number (WGS84 longitude).' })
  @Min(-180, { message: 'lng must be between -180 and 180.' })
  @Max(180, { message: 'lng must be between -180 and 180.' })
  lng!: number;

  @IsOptional()
  @IsString({ message: 'note must be a string.' })
  @MaxLength(500, { message: 'note must be at most 500 characters.' })
  note?: string;
}
