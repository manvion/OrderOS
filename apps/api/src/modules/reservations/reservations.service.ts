import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ReservationStatus } from '@prisma/client';
import { WEEKDAYS, type BusinessHours, type CreateReservationInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { EmailService } from '../notifications/email.service';

/** A bookable (or full) time slot, returned to the storefront. */
export interface ReservationSlot {
  /** Local wall-clock label, e.g. "19:00". */
  time: string;
  /** The exact instant, UTC ISO — what the client sends back to book. */
  iso: string;
  available: boolean;
}

/** The public settings the storefront form needs. */
export interface ReservationSettings {
  enabled: boolean;
  maxPartySize: number;
  leadHours: number;
  windowDays: number;
}

const RESTAURANT_RESERVATION_SELECT = {
  reservationsEnabled: true,
  reservationCapacityPerSlot: true,
  reservationSlotMinutes: true,
  reservationMaxPartySize: true,
  reservationLeadHours: true,
  reservationWindowDays: true,
  businessHours: true,
  timezone: true,
} as const;

/**
 * Table reservations — "simple capacity per slot".
 *
 * The restaurant sets how many bookings it will take for any one time slot; a slot is
 * available while the live (CONFIRMED/SEATED) bookings at that exact start time are
 * below that number. Slots themselves come from the restaurant's opening hours at its
 * chosen granularity, respecting a minimum lead time and a booking window.
 *
 * No per-table assignment and no deposit — deliberately the simplest model that works,
 * which the restaurant can grow out of later. Bookings auto-confirm the moment capacity
 * allows, so there's no approve step in the customer's way.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // --- Timezone helpers ----------------------------------------------------

  /** The offset (ms) that `timeZone` has at `date`: wallClock(tz) - UTC. */
  private tzOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(date)) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
    return asUTC - date.getTime();
  }

  /** The UTC instant of a wall-clock time in `timeZone` (e.g. 19:00 in Toronto). */
  private zonedWallTimeToUtc(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    timeZone: string,
  ): Date {
    const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
    // Correct the naive guess by the offset the zone actually has near that instant.
    const offset = this.tzOffsetMs(new Date(naiveUTC), timeZone);
    return new Date(naiveUTC - offset);
  }

  /** Today's calendar date in `timeZone`. */
  private todayInTz(timeZone: string): { y: number; mo: number; d: number } {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(new Date())) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    return { y: map.year, mo: map.month, d: map.day };
  }

  // --- Storefront (public) -------------------------------------------------

  async settings(restaurantId: string): Promise<ReservationSettings> {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: RESTAURANT_RESERVATION_SELECT,
    });
    const enabled = Boolean(r?.reservationsEnabled && r.reservationCapacityPerSlot > 0);
    return {
      enabled,
      maxPartySize: r?.reservationMaxPartySize ?? 10,
      leadHours: r?.reservationLeadHours ?? 2,
      windowDays: r?.reservationWindowDays ?? 30,
    };
  }

  /**
   * Bookable slots for one calendar date (YYYY-MM-DD, read in the restaurant's tz).
   *
   * Empty list when reservations are off, the date is outside the window, or the
   * restaurant is closed that day — the storefront shows "no times" rather than an
   * error.
   */
  async availability(restaurantId: string, dateStr: string): Promise<ReservationSlot[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('Invalid date');
    }
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: RESTAURANT_RESERVATION_SELECT,
    });
    if (!r || !r.reservationsEnabled || r.reservationCapacityPerSlot <= 0) return [];

    const [y, mo, d] = dateStr.split('-').map(Number);

    // Inside the booking window? Compare calendar dates in the restaurant's tz.
    const today = this.todayInTz(r.timezone);
    const dateNum = y * 10000 + mo * 100 + d;
    const todayNum = today.y * 10000 + today.mo * 100 + today.d;
    if (dateNum < todayNum) return [];
    const windowEnd = new Date(Date.UTC(today.y, today.mo - 1, today.d));
    windowEnd.setUTCDate(windowEnd.getUTCDate() + r.reservationWindowDays);
    const windowEndNum =
      windowEnd.getUTCFullYear() * 10000 +
      (windowEnd.getUTCMonth() + 1) * 100 +
      windowEnd.getUTCDate();
    if (dateNum > windowEndNum) return [];

    const hours = (r.businessHours as BusinessHours | null) ?? null;
    const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
    const day = hours?.[weekday];
    if (!day || day.closed || day.windows.length === 0) return [];

    const step = r.reservationSlotMinutes;
    const earliest = new Date(Date.now() + r.reservationLeadHours * 3_600_000);

    // Build the candidate slot instants from each opening window.
    const slots: ReservationSlot[] = [];
    for (const w of day.windows) {
      const [oh, om] = w.open.split(':').map(Number);
      let [ch, cm] = w.close.split(':').map(Number);
      let startMin = oh * 60 + om;
      let closeMin = ch * 60 + cm;
      // Overnight window (closes after midnight): let the last seating run to it.
      if (closeMin <= startMin) closeMin += 24 * 60;

      // Last seating is one slot before close — nobody is seated at closing time.
      for (let m = startMin; m + step <= closeMin; m += step) {
        const hh = Math.floor(m / 60) % 24;
        const mm = m % 60;
        const dayOffset = Math.floor(m / (24 * 60));
        const instant = this.zonedWallTimeToUtc(y, mo, d + dayOffset, hh, mm, r.timezone);
        if (instant < earliest) continue;
        slots.push({
          time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
          iso: instant.toISOString(),
          available: true, // filled in below
        });
      }
    }
    if (slots.length === 0) return [];

    // One query for the day's live bookings, counted per exact slot start.
    const first = new Date(slots[0].iso);
    const last = new Date(slots[slots.length - 1].iso);
    const booked = await this.prisma.reservation.findMany({
      where: {
        restaurantId,
        status: { in: ['CONFIRMED', 'SEATED'] },
        reservedAt: { gte: first, lte: last },
      },
      select: { reservedAt: true },
    });
    const counts = new Map<string, number>();
    for (const b of booked) {
      const key = b.reservedAt.toISOString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return slots.map((s) => ({
      ...s,
      available: (counts.get(s.iso) ?? 0) < r.reservationCapacityPerSlot,
    }));
  }

  /**
   * Book a table. Auto-confirms if the chosen slot is still a valid, available slot.
   *
   * The capacity check runs inside a transaction so two people racing for the last
   * seat can't both win it.
   */
  async book(restaurantId: string, input: CreateReservationInput) {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: RESTAURANT_RESERVATION_SELECT,
    });
    if (!r || !r.reservationsEnabled || r.reservationCapacityPerSlot <= 0) {
      throw new BadRequestException('This restaurant is not taking reservations');
    }
    if (input.partySize > r.reservationMaxPartySize) {
      throw new BadRequestException(
        `Parties larger than ${r.reservationMaxPartySize} — please call the restaurant`,
      );
    }

    const reservedAt = new Date(input.reservedAt);
    if (Number.isNaN(reservedAt.getTime())) throw new BadRequestException('Invalid time');

    // The requested instant must be one of the slots we actually offer that day, so a
    // hand-crafted time can't slip past the hours/lead-time rules.
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: r.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(reservedAt);
    const slots = await this.availability(restaurantId, dateStr);
    const slot = slots.find((s) => s.iso === reservedAt.toISOString());
    if (!slot) throw new BadRequestException('That time is no longer available');

    const reservation = await this.prisma.$transaction(async (tx) => {
      const live = await tx.reservation.count({
        where: { restaurantId, reservedAt, status: { in: ['CONFIRMED', 'SEATED'] } },
      });
      if (live >= r.reservationCapacityPerSlot) {
        throw new BadRequestException('That time was just taken — please pick another');
      }
      return tx.reservation.create({
        data: {
          restaurantId,
          status: 'CONFIRMED',
          customerName: input.customerName.trim(),
          customerPhone: input.customerPhone.trim(),
          customerEmail: input.customerEmail?.trim() || null,
          partySize: input.partySize,
          reservedAt,
          notes: input.notes?.trim() || null,
        },
      });
    });

    void this.notify(reservation.id);
    return { reservationId: reservation.id, reservedAt: reservation.reservedAt.toISOString() };
  }

  /**
   * Tell the restaurant a table was booked, and confirm to the customer if they left
   * an email. Fire-and-forget — a booking must never fail over a notification.
   */
  private async notify(reservationId: string): Promise<void> {
    try {
      const res = await this.prisma.reservation.findUnique({
        where: { id: reservationId },
        include: {
          restaurant: {
            select: {
              name: true,
              email: true,
              notifyEmail: true,
              logoUrl: true,
              brandPrimaryColor: true,
              street: true,
              city: true,
              phone: true,
              legalName: true,
              taxId: true,
              country: true,
              currency: true,
              timezone: true,
            },
          },
        },
      });
      if (!res) return;

      const when = new Intl.DateTimeFormat('en-CA', {
        timeZone: res.restaurant.timezone,
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(res.reservedAt);
      const esc = (s: string) =>
        s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
      const row = (label: string, value: string) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${label}</td><td style="padding:4px 0;font-weight:600;">${esc(value)}</td></tr>`;

      // Restaurant alert.
      const to = res.restaurant.notifyEmail ?? res.restaurant.email;
      await this.email.sendRaw({
        to,
        subject: `New reservation — party of ${res.partySize} on ${when}`,
        body:
          `<h1 style="margin:0 0 8px;font-size:22px;">New table reservation</h1>` +
          `<table style="font-size:14px;border-collapse:collapse;">` +
          row('When', when) +
          row('Party', String(res.partySize)) +
          row('Name', res.customerName) +
          row('Phone', res.customerPhone) +
          (res.customerEmail ? row('Email', res.customerEmail) : '') +
          `</table>` +
          (res.notes
            ? `<p style="margin:16px 0 0;padding:12px;background:#f1f5f9;border-radius:8px;font-size:14px;">${esc(res.notes)}</p>`
            : '') +
          `<p style="margin:20px 0 0;color:#64748b;font-size:13px;">Open your dashboard → Reservations to manage it.</p>`,
        restaurant: res.restaurant,
        replyTo: res.customerEmail ?? undefined,
      });

      // Customer confirmation (only if they gave an email).
      if (res.customerEmail) {
        await this.email.sendRaw({
          to: res.customerEmail,
          subject: `Your table at ${res.restaurant.name} — ${when}`,
          body:
            `<h1 style="margin:0 0 8px;font-size:22px;">You're booked!</h1>` +
            `<p style="margin:0 0 16px;color:#334155;">We've saved your table at ${esc(res.restaurant.name)}.</p>` +
            `<table style="font-size:14px;border-collapse:collapse;">` +
            row('When', when) +
            row('Party', String(res.partySize)) +
            row('Where', `${esc(res.restaurant.street)}, ${esc(res.restaurant.city)}`) +
            `</table>` +
            `<p style="margin:20px 0 0;color:#64748b;font-size:13px;">Need to change or cancel? Call ${esc(res.restaurant.phone)}.</p>`,
          restaurant: res.restaurant,
        });
      }
    } catch (err) {
      this.logger.warn(`Could not send reservation alert: ${(err as Error).message}`);
    }
  }

  // --- Admin ---------------------------------------------------------------

  /** Upcoming + recent bookings for the dashboard, newest booking last within a day. */
  listReservations(restaurantId: string) {
    // Everything from the start of today onward, plus a little history for context.
    const since = new Date(Date.now() - 24 * 3_600_000);
    return this.prisma.reservation.findMany({
      where: { restaurantId, reservedAt: { gte: since } },
      orderBy: { reservedAt: 'asc' },
      take: 500,
    });
  }

  async updateStatus(
    restaurantId: string,
    id: string,
    status: ReservationStatus,
    userId?: string,
  ) {
    const existing = await this.prisma.reservation.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Reservation not found');

    const reservation = await this.prisma.reservation.update({ where: { id }, data: { status } });
    await this.audit.log({
      restaurantId,
      userId,
      action: 'reservation.status_changed',
      entityType: 'Reservation',
      entityId: id,
      metadata: { status },
    });
    return reservation;
  }
}
