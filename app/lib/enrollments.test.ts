import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  emailOutbox,
  enrollments,
  notifications,
  NotificationType,
  OutboxStatus,
  purchases,
  UserRole,
  users,
} from "~/db/schema";
import {
  getUnreadCount,
  listRecentNotifications,
  writeNotification,
} from "./notifications.server";
import { completeIndividualPurchase, isLapsed } from "./enrollments";

describe("isLapsed", () => {
  it("is false while the student still has an Enrollment", () => {
    expect(isLapsed({ enrollmentId: 12 })).toBe(false);
  });

  it("is true once the student's Enrollment has ended", () => {
    expect(isLapsed({ enrollmentId: null })).toBe(true);
  });
});

describe("completeIndividualPurchase", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let base: ReturnType<typeof seedBaseData>;
  let student: typeof users.$inferSelect;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    student = testDb
      .insert(users)
      .values({
        name: "Alice Student",
        email: "alice@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
  });

  it("creates purchase, enrollment, notification, and outbox row for student", () => {
    const unreadBefore = getUnreadCount(testDb, student.id);
    const outboxBefore = testDb.select().from(emailOutbox).all().length;

    const result = completeIndividualPurchase(testDb, {
      userId: student.id,
      courseId: base.course.id,
      amountPaid: 7900,
      country: "US",
    });

    expect(result.purchase).toBeDefined();
    expect(result.purchase.userId).toBe(student.id);
    expect(result.purchase.courseId).toBe(base.course.id);
    expect(result.purchase.amountPaid).toBe(7900);
    expect(result.purchase.country).toBe("US");

    expect(result.enrollment).toBeDefined();
    expect(result.enrollment.userId).toBe(student.id);
    expect(result.enrollment.courseId).toBe(base.course.id);

    // Verify in-app notification
    expect(getUnreadCount(testDb, student.id)).toBe(unreadBefore + 1);
    const recent = listRecentNotifications(testDb, student.id);
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe(NotificationType.PurchaseConfirmed);
    expect(recent[0].title).toBe(`Purchase confirmed: "${base.course.title}"`);
    expect(recent[0].deepLink).toBe(`/courses/${base.course.slug}/welcome`);
    expect(recent[0].mandatory).toBe(true);
    expect(recent[0].read).toBe(false);

    // Verify email outbox row
    const outboxRows = testDb
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.notificationId, recent[0].id))
      .all();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe(OutboxStatus.Pending);

    // Verify total outbox count increased by 1
    const outboxAfter = testDb.select().from(emailOutbox).all().length;
    expect(outboxAfter).toBe(outboxBefore + 1);
  });

  it("prevents duplicate notification and outbox row with dedupe key", () => {
    const result = completeIndividualPurchase(testDb, {
      userId: student.id,
      courseId: base.course.id,
      amountPaid: 7900,
    });

    const outboxCountBefore = testDb.select().from(emailOutbox).all().length;
    const notifCountBefore = testDb.select().from(notifications).all().length;

    // Attempt to write duplicate notification with same dedupeKey
    const duplicateNotifId = writeNotification(testDb, {
      recipientUserId: student.id,
      type: NotificationType.PurchaseConfirmed,
      payload: {
        purchaseId: result.purchase.id,
        courseId: base.course.id,
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
        amountPaid: result.purchase.amountPaid,
      },
      dedupeKey: `purchase-confirmed:${result.purchase.id}`,
    });

    expect(duplicateNotifId).toBeNull();

    const outboxCountAfter = testDb.select().from(emailOutbox).all().length;
    const notifCountAfter = testDb.select().from(notifications).all().length;

    expect(notifCountAfter).toBe(notifCountBefore);
    expect(outboxCountAfter).toBe(outboxCountBefore);
  });

  it("fails if student is already enrolled in the course", () => {
    completeIndividualPurchase(testDb, {
      userId: student.id,
      courseId: base.course.id,
      amountPaid: 7900,
    });

    expect(() =>
      completeIndividualPurchase(testDb, {
        userId: student.id,
        courseId: base.course.id,
        amountPaid: 7900,
      })
    ).toThrow("User is already enrolled in this course");
  });
});
