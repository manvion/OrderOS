import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ROLE_RANK, type ShiftInput, type StaffRole } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertRestaurantCapability } from '../../common/plan/plan.util';

export interface ListShiftsOptions {
  from?: Date;
  to?: Date;
  /** Ignored for STAFF -- see listShifts. */
  userId?: string;
}

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  private userInclude() {
    return { user: { select: { id: true, firstName: true, lastName: true, email: true } } } as const;
  }

  /**
   * A manager sees whoever they ask for (or everyone, in range). Staff always
   * see only their own shifts -- the schedule of who else is working isn't
   * confidential, but there's no reason to build a second endpoint just to
   * enforce that, so the scoping happens here based on the caller's role.
   */
  async listShifts(
    restaurantId: string,
    actingRole: StaffRole,
    actingUserId: string,
    options: ListShiftsOptions,
  ) {
    const isManager = ROLE_RANK[actingRole] >= ROLE_RANK.MANAGER;

    return this.prisma.shift.findMany({
      where: {
        restaurantId,
        userId: isManager ? options.userId : actingUserId,
        ...(options.from || options.to
          ? {
              startsAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lt: options.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { startsAt: 'asc' },
      include: this.userInclude(),
    });
  }

  async createShift(restaurantId: string, input: ShiftInput) {
    await assertRestaurantCapability(this.prisma, restaurantId, 'SHIFTS');

    const member = await this.prisma.user.findFirst({
      where: { id: input.userId, restaurantId, isActive: true },
    });
    if (!member) throw new NotFoundException('Staff member not found');

    return this.prisma.shift.create({
      data: {
        restaurantId,
        userId: input.userId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        note: input.note,
      },
      include: this.userInclude(),
    });
  }

  async updateShift(restaurantId: string, id: string, input: Partial<ShiftInput>) {
    const existing = await this.prisma.shift.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Shift not found');

    if (input.userId) {
      const member = await this.prisma.user.findFirst({
        where: { id: input.userId, restaurantId, isActive: true },
      });
      if (!member) throw new NotFoundException('Staff member not found');
    }

    const startsAt = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
    const endsAt = input.endsAt ? new Date(input.endsAt) : existing.endsAt;
    if (endsAt <= startsAt) {
      throw new BadRequestException('A shift must end after it starts');
    }

    return this.prisma.shift.update({
      where: { id },
      data: { userId: input.userId, startsAt, endsAt, note: input.note },
      include: this.userInclude(),
    });
  }

  async deleteShift(restaurantId: string, id: string) {
    const existing = await this.prisma.shift.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Shift not found');

    await this.prisma.shift.delete({ where: { id } });
  }
}
