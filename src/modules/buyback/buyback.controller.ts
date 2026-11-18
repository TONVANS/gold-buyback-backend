import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { ApprovalStatus } from '@prisma/client';
import { BuybackService } from './buyback.service';
import {
  CancelBuybackDto,
  CreateBuybackDto,
  ListBuybackDto,
  PreviewBuybackDto,
  ReviewBuybackDto,
  SettleBuybackPaymentDto,
  UpdateBuybackDto,
} from './dto/buyback.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequiresOpenShift } from '../../common/decorators/requires-shift.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('buyback')
@ApiBearerAuth('bearer')
@Controller('buyback')
export class BuybackController {
  constructor(private readonly buyback: BuybackService) {}

  // The date range defaults to today and a Valuer cannot widen it —
  // HistoryRangeService enforces that, not the client.
  @Get()
  list(@Query() query: ListBuybackDto, @CurrentUser() user: AuthenticatedUser) {
    return this.buyback.list(query.status as ApprovalStatus | undefined, query, user);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.buyback.getOne(id, user);
  }

  /** Live §5.1 calculation for the Valuer's form. */
  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Post('preview')
  preview(@Body() dto: PreviewBuybackDto) {
    return this.buyback.preview(dto);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post()
  create(@Body() dto: CreateBuybackDto, @CurrentUser() user: AuthenticatedUser, @Req() req: any) {
    // ShiftGuard attaches the open shift; ADMIN/MANAGER are exempt from the
    // guard, so they must be acting on an explicit shift.
    const shiftId = req.shift?.id as string | undefined;
    if (!shiftId) throw new BadRequestException('ຕ້ອງເປີດກະກ່ອນສ້າງລາຍການ Buyback');
    return this.buyback.create(dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBuybackDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.buyback.update(id, dto, user);
  }

  /** payment ກົດ Approve / Reject (TOR §4.2). */
  @Roles('PAYMENT', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/review')
  review(
    @Param('id') id: string,
    @Body() dto: ReviewBuybackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.buyback.review(id, dto, user, shiftId);
  }

  /** ຜູ້ປະເມີນ ກົດຢືນຢັນອີກຄັ້ງ -> Completed. */
  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: any) {
    const shiftId = req.shift?.id as string | undefined;
    return this.buyback.confirm(id, user, shiftId);
  }

  /** ຍົກເລີກລາຍການທີ່ຍັງບໍ່ທັນ COMPLETED. */
  @Roles('VALUER', 'PAYMENT', 'ADMIN', 'MANAGER')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelBuybackDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.buyback.cancel(id, dto, user);
  }

  /** ຊຳລະຍອດຄ້າງຈ່າຍເພີ່ມເຕີມ (ຖ້າມີ). */
  @Roles('VALUER', 'PAYMENT', 'ADMIN', 'MANAGER')
  @RequiresOpenShift()
  @Post(':id/payments')
  addPayment(
    @Param('id') id: string,
    @Body() dto: SettleBuybackPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: any,
  ) {
    const shiftId = req.shift?.id as string | undefined;
    return this.buyback.addPayment(id, dto, user, shiftId);
  }

  @Roles('VALUER', 'ADMIN', 'MANAGER')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.buyback.remove(id, user);
  }
}
