import { IsIn } from 'class-validator';

export class VoteReportDto {
  @IsIn([1, -1], {
    message: 'vote must be 1 (confirm) or -1 (deny).',
  })
  vote!: 1 | -1;
}
