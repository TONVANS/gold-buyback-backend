import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ApprovalsService } from './approvals.service';
import { ListApprovalsHistoryDto } from './dto/approvals.dto';

@ApiTags('approvals')
@ApiBearerAuth('bearer')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Roles('PAYMENT', 'ADMIN', 'MANAGER')
  @Get('history')
  history(@Query() query: ListApprovalsHistoryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.approvals.history(query, user);
  }
}
