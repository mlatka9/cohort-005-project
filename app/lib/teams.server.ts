import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  coupons,
  courses,
  enrollments,
  purchases,
  teamMembers,
  TeamMemberRole,
  teams,
  users,
  NotificationType,
} from "~/db/schema";
import { writeNotification } from "~/lib/notifications.server";
import { getSeatAvailability } from "~/lib/refunds.server";

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export function getTeamForAdmin(db: Queryable, userId: number) {
  const membership = db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (!membership) return undefined;

  return db.select().from(teams).where(eq(teams.id, membership.teamId)).get();
}

export function getOrCreateTeamForUser(db: Queryable, userId: number) {
  const existingTeam = getTeamForAdmin(db, userId);
  if (existingTeam) return existingTeam;

  const team = db.insert(teams).values({}).returning().get();
  db.insert(teamMembers)
    .values({ teamId: team.id, userId, role: TeamMemberRole.Admin })
    .returning()
    .get();
  return team;
}

export interface CreateTeamPurchaseParams {
  userId: number;
  courseId: number;
  amountPaid: number;
  quantity: number;
  country?: string | null;
}

export function createTeamPurchase(
  db: Db,
  paramsOrUserId: CreateTeamPurchaseParams | number,
  courseId?: number,
  amountPaid?: number,
  country?: string | null,
  quantity?: number
): {
  purchase: typeof purchases.$inferSelect;
  team: typeof teams.$inferSelect;
  coupons: (typeof coupons.$inferSelect)[];
} {
  const params: CreateTeamPurchaseParams =
    typeof paramsOrUserId === "number"
      ? {
          userId: paramsOrUserId,
          courseId: courseId!,
          amountPaid: amountPaid!,
          country: country ?? null,
          quantity: quantity!,
        }
      : paramsOrUserId;

  return db.transaction((tx) => {
    const course = tx
      .select()
      .from(courses)
      .where(eq(courses.id, params.courseId))
      .get();

    if (!course) {
      throw new Error("Course not found");
    }

    const purchase = tx
      .insert(purchases)
      .values({
        userId: params.userId,
        courseId: params.courseId,
        amountPaid: params.amountPaid,
        country: params.country ?? null,
      })
      .returning()
      .get();

    const team = getOrCreateTeamForUser(tx, params.userId);

    const createdCoupons: (typeof coupons.$inferSelect)[] = [];
    for (let i = 0; i < params.quantity; i++) {
      const coupon = tx
        .insert(coupons)
        .values({
          teamId: team.id,
          courseId: params.courseId,
          code: crypto.randomBytes(12).toString("base64url"),
          purchaseId: purchase.id,
        })
        .returning()
        .get();
      createdCoupons.push(coupon);
    }

    writeNotification(tx, {
      recipientUserId: params.userId,
      type: NotificationType.TeamLicencePurchased,
      payload: {
        purchaseId: purchase.id,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        seatCount: params.quantity,
        couponCodes: createdCoupons.map((c) => c.code),
      },
      dedupeKey: `team-licence-purchased:${purchase.id}`,
    });

    return { purchase, team, coupons: createdCoupons };
  });
}

export interface RedeemCouponParams {
  code: string;
  userId: number;
  userCountry?: string | null;
}

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

export function redeemCoupon(
  db: Db,
  paramsOrCode: RedeemCouponParams | string,
  userId?: number,
  userCountry?: string | null
): RedeemResult {
  const params: RedeemCouponParams =
    typeof paramsOrCode === "string"
      ? {
          code: paramsOrCode,
          userId: userId!,
          userCountry: userCountry ?? null,
        }
      : paramsOrCode;

  return db.transaction((tx): RedeemResult => {
    const coupon = tx
      .select()
      .from(coupons)
      .where(eq(coupons.code, params.code))
      .get();

    if (!coupon) {
      return { ok: false, error: "Coupon not found" };
    }

    if (coupon.redeemedByUserId !== null) {
      return { ok: false, error: "Coupon has already been redeemed" };
    }

    const availability = getSeatAvailability(tx, coupon);
    if (availability === "on_hold") {
      return { ok: false, error: SEAT_ON_HOLD };
    }
    if (availability === "refunded") {
      return { ok: false, error: SEAT_REFUNDED };
    }

    const existingEnrollment = tx
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, params.userId),
          eq(enrollments.courseId, coupon.courseId)
        )
      )
      .get();

    if (existingEnrollment) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, coupon.purchaseId))
      .get();

    if (
      purchase?.country &&
      params.userCountry &&
      purchase.country !== params.userCountry
    ) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    tx.update(coupons)
      .set({
        redeemedByUserId: params.userId,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(coupons.id, coupon.id))
      .run();

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: params.userId, courseId: coupon.courseId })
      .returning()
      .get();

    // Look up team admin(s) for the team that owns the coupon
    const teamAdmins = tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, coupon.teamId),
          eq(teamMembers.role, TeamMemberRole.Admin)
        )
      )
      .all();

    const course = tx
      .select({
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
      })
      .from(courses)
      .where(eq(courses.id, coupon.courseId))
      .get();

    const student = tx
      .select({
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, params.userId))
      .get();

    for (const admin of teamAdmins) {
      writeNotification(tx, {
        recipientUserId: admin.userId,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: coupon.id,
          courseId: coupon.courseId,
          courseTitle: course?.title ?? "Course",
          courseSlug: course?.slug ?? "",
          studentName: student?.name ?? "Student",
          studentEmail: student?.email ?? "",
        },
        dedupeKey: `seat-claimed:${coupon.id}`,
      });
    }

    return { ok: true, enrollment };
  });
}
