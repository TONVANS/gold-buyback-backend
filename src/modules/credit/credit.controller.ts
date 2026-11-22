import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { ApprovalStatus } from '@prisma/client';
import { CreditService } from './credit.service';
import {
  CancelCreditDto,
  CreateCreditDto,
  ListCreditDto,
  ReceiveCreditDto,
  ReviewCreditDto,
  UpdateCreditDto,
} from './dto/credit.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresOpenShift } from '../../common/decorators/requires-shift.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('credit')
@ApiBearerAuth('bearer')
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  // The date range defaults to today and a Valuer cannot widen it —
  // HistoryRangeService enforces that, not the client.
  @Get()
  list(@Query() query: ListCreditDto, @CurrentUser() user: AuthenticatedUser) {
    return this.credit.list(query.status as ApprovalStatus | undefined, query, user);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.credit.getOne(id, user);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post()
  create(@Body() dto: CreateCreditDto, @CurrentUser() user: AuthenticatedUser, @Req() req: any) {
    const shiftId = req.shift?.id as string | undefined;
    if (!shiftId) throw new BadRequestException('ຕ້ອງເປີດກະກ່ອນສ້າງລາຍການສິນເຊື່ອ');
    return this.credit.create(dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCreditDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.credit.update(id, dto, user);
  }

  @Roles('PAYMENT', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/review')
  review(
    @Param('id') id: string,
    @Body() dto: ReviewCreditDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.credit.review(id, dto, user, shiftId);
  }

  @Roles('VALUER', 'PAYMENT', 'ADMIN', 'MANAGER')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelCreditDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.credit.cancel(id, dto, user);
  }

  /** ຮັບຄ່າງວດ — draws down the outstanding AR (Cash). */
  @Roles('PAYMENT', 'FINANCIAL_CONTROLLER', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/receipts')
  addReceipt(
    @Param('id') id: string,
    @Body() dto: ReceiveCreditDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.credit.addReceipt(id, dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.credit.remove(id, user);
  }
}
