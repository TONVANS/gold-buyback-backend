import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BlankIsAbsent, TimeSearchHistoryRangeDto } from '../../../common/dto/history-range.dto';

export const APPROVAL_TYPES = ['BUYBACK', 'EXCHANGE', 'CREDIT'] as const;
export type ApprovalHistoryType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ApprovalHistoryDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_HISTORY_STATUSES = ['APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalHistoryStatus = (typeof APPROVAL_HISTORY_STATUSES)[number];

export class ListApprovalsHistoryDto extends TimeSearchHistoryRangeDto {
  @ApiPropertyOptional({ enum: APPROVAL_TYPES, description: 'ປະເພດທຸລະກຳ' })
  @IsOptional()
  @BlankIsAbsent()
  @IsIn(APPROVAL_TYPES)
  type?: ApprovalHistoryType;

  @ApiPropertyOptional({
    enum: APPROVAL_DECISIONS,
    description: 'ຜົນການພິຈາລະນາແບບລວມ (APPROVED ລວມທັງ APPROVED ແລະ COMPLETED)',
  })
  @IsOptional()
  @BlankIsAbsent()
  @IsIn(APPROVAL_DECISIONS)
  decision?: ApprovalHistoryDecision;

  @ApiPropertyOptional({ enum: APPROVAL_HISTORY_STATUSES, description: 'ສະຖານະຕົວຈິງຂອງລາຍການ' })
  @IsOptional()
  @BlankIsAbsent()
  @IsIn(APPROVAL_HISTORY_STATUSES)
  status?: ApprovalHistoryStatus;
}
