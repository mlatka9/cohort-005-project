import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, enrollments, purchases, NotificationType } from "~/db/schema";
import { writeNotification } from "~/lib/notifications.server";

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

/** A student on the roster who no longer has an Enrollment. */
export function isLapsed(student: { enrollmentId: number | null }): boolean {
  return student.enrollmentId === null;
}

export interface CompleteIndividualPurchaseParams {
  userId: number;
  courseId: number;
  amountPaid: number;
  country?: string | null;
}

export function completeIndividualPurchase(
  db: Db,
  params: CompleteIndividualPurchaseParams
) {
  const { userId, courseId, amountPaid, country = null } = params;

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(enrollments)
      .where(
        and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
      )
      .get();

    if (existing) {
      throw new Error("User is already enrolled in this course");
    }

    const course = tx
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();

    if (!course) {
      throw new Error("Course not found");
    }

    const purchase = tx
      .insert(purchases)
      .values({
        userId,
        courseId,
        amountPaid,
        country,
      })
      .returning()
      .get();

    const enrollment = tx
      .insert(enrollments)
      .values({
        userId,
        courseId,
      })
      .returning()
      .get();

    writeNotification(tx, {
      recipientUserId: userId,
      type: NotificationType.PurchaseConfirmed,
      payload: {
        purchaseId: purchase.id,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        amountPaid: purchase.amountPaid,
      },
      dedupeKey: `purchase-confirmed:${purchase.id}`,
    });

    return { purchase, enrollment };
  });
}

