import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RemoveReportDto {
  @IsOptional()
  @IsString({ message: 'reason must be a string.' })
  @MaxLength(300, { message: 'reason must be 300 characters or fewer.' })
  reason?: string;
}
