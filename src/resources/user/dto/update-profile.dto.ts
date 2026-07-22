import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Body of PATCH /me. Omitted fields are left unchanged. */
export class UpdateProfileDto {
  /** Display name. Cannot be cleared — omit to keep the current one. */
  @ValidateIf((o: UpdateProfileDto) => o.name !== undefined)
  @IsString({ message: 'name must be a string.' })
  @IsNotEmpty({
    message: 'name cannot be empty — omit it to keep your current name.',
  })
  @MaxLength(120, { message: 'name must be 120 characters or fewer.' })
  name?: string;

  /** Phone number. Send null to clear it. */
  @IsOptional()
  @IsString({ message: 'phone must be a string.' })
  @MaxLength(32, { message: 'phone must be 32 characters or fewer.' })
  phone?: string | null;

  /** Avatar image URL. Send null to clear it. */
  @IsOptional()
  @IsUrl(
    { require_protocol: true },
    {
      message:
        'avatarUrl must be a full URL including the protocol (https://…).',
    },
  )
  avatarUrl?: string | null;
}
