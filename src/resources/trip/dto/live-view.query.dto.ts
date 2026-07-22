import { IsOptional, IsString } from 'class-validator';

export class LiveViewQueryDto {
  /** Trip share token (issued at trip creation or via POST /trips/:id/share). */
  @IsOptional()
  @IsString({ message: 'token must be a string' })
  token?: string;
}
