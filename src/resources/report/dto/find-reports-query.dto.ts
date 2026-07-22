import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class FindReportsQueryDto {
  @IsString({
    message:
      "bbox query param is required — format 'minLng,minLat,maxLng,maxLat' (e.g. '3.35,6.44,3.42,6.52').",
  })
  @IsNotEmpty({
    message:
      "bbox query param is required — format 'minLng,minLat,maxLng,maxLat' (e.g. '3.35,6.44,3.42,6.52').",
  })
  bbox!: string;

  /** Optional comma-separated ReportType filter, e.g. 'ROBBERY,ACCIDENT'. */
  @IsOptional()
  @IsString({
    message: 'types must be a comma-separated list of report types.',
  })
  types?: string;
}
