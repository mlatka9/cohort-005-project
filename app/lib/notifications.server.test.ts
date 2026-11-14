import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  emailOutbox,
  notificationPreferences,
  notifications,
  NotificationType,
  OutboxStatus,
  UserRole,
  users,
} from "~/db/schema";
import {
  writeNotification,
  writeNotifications,
  getUnreadCount,
  listRecentNotifications,
  listPaginatedNotifications,
  markAsRead,
  markAllAsRead,
} from "./notifications.server";

describe("Notification Service", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let user: { id: number; name: string; email: string };

  beforeEach(() => {
    testDb = createTestDb();
    const base = seedBaseData(testDb);
    user = base.user;
  });

  it("writes a notification and increments unread count", () => {
    expect(getUnreadCount(testDb, user.id)).toBe(0);

    const notificationId = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 10,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        decision: "approved",
        amountRefunded: 5000,
      },
      dedupeKey: "refund-decided:1",
    });

    expect(notificationId).toBeTypeOf("number");
    expect(getUnreadCount(testDb, user.id)).toBe(1);

    const recent = listRecentNotifications(testDb, user.id);
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe(notificationId);
    expect(recent[0].read).toBe(false);
    expect(recent[0].title).toBe('Your refund for "Test Course" was approved');
    expect(recent[0].deepLink).toBe("/courses/test-course");
    expect(recent[0].mandatory).toBe(true);
  });

  it("deduplicates notifications with the same dedupeKey for the same recipient", () => {
    const id1 = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 10,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        decision: "approved",
      },
      dedupeKey: "refund-decided:1",
    });

    expect(id1).toBeTypeOf("number");

    // Attempt second insert with same dedupeKey
    const id2 = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 10,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        decision: "approved",
      },
      dedupeKey: "refund-decided:1",
    });

    expect(id2).toBeNull();
    expect(getUnreadCount(testDb, user.id)).toBe(1);
  });

  it("allows same dedupeKey for different recipients", () => {
    const secondUser = testDb
      .insert(users)
      .values({
        name: "Second User",
        email: "second@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const id1 = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundRequestRaised,
      payload: {
        refundRequestId: 100,
        purchaseId: 10,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        buyerName: "Buyer",
        amountPaid: 5000,
      },
      dedupeKey: "refund-request-raised:100",
    });

    const id2 = writeNotification(testDb, {
      recipientUserId: secondUser.id,
      type: NotificationType.RefundRequestRaised,
      payload: {
        refundRequestId: 100,
        purchaseId: 10,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        buyerName: "Buyer",
        amountPaid: 5000,
      },
      dedupeKey: "refund-request-raised:100",
    });

    expect(id1).toBeTypeOf("number");
    expect(id2).toBeTypeOf("number");
    expect(id1).not.toBe(id2);
  });

  it("marks a single notification as read", () => {
    const id = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.PurchaseConfirmed,
      payload: {
        purchaseId: 1,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        amountPaid: 7900,
      },
    });

    expect(getUnreadCount(testDb, user.id)).toBe(1);

    markAsRead(testDb, user.id, id!);

    expect(getUnreadCount(testDb, user.id)).toBe(0);
    const recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].read).toBe(true);
    expect(recent[0].readAt).not.toBeNull();
  });

  it("does not allow marking another user's notification as read", () => {
    const otherUser = testDb
      .insert(users)
      .values({
        name: "Other User",
        email: "other@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const id = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.PurchaseConfirmed,
      payload: {
        purchaseId: 1,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        amountPaid: 7900,
      },
    });

    // otherUser attempts to mark user's notification
    markAsRead(testDb, otherUser.id, id!);

    // user's notification should still be unread
    expect(getUnreadCount(testDb, user.id)).toBe(1);
  });

  it("marks all notifications as read for a user", () => {
    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 1,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        decision: "approved",
      },
      dedupeKey: "ref-1",
    });

    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 2,
        purchaseId: 2,
        courseId: 1,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        decision: "declined",
        decisionNote: "Policy violated",
      },
      dedupeKey: "ref-2",
    });

    expect(getUnreadCount(testDb, user.id)).toBe(2);

    markAllAsRead(testDb, user.id);

    expect(getUnreadCount(testDb, user.id)).toBe(0);
    const recent = listRecentNotifications(testDb, user.id);
    expect(recent.every((n) => n.read)).toBe(true);
  });

  it("paginates notifications with page and perPage", () => {
    for (let i = 1; i <= 5; i++) {
      writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: i,
          purchaseId: i,
          courseId: 1,
          courseTitle: `Course ${i}`,
          courseSlug: `course-${i}`,
          decision: "approved",
        },
        dedupeKey: `k-${i}`,
      });
    }

    const page1 = listPaginatedNotifications(testDb, user.id, 1, 2);
    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(3);
    expect(page1.notifications).toHaveLength(2);
    expect(page1.notifications[0].title).toBe('Your refund for "Course 5" was approved');
    expect(page1.notifications[1].title).toBe('Your refund for "Course 4" was approved');

    const page3 = listPaginatedNotifications(testDb, user.id, 3, 2);
    expect(page3.notifications).toHaveLength(1);
    expect(page3.notifications[0].title).toBe('Your refund for "Course 1" was approved');
  });

  it("supports writeNotifications batch helper", () => {
    const ids = writeNotifications(testDb, [
      {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 10,
          purchaseId: 10,
          courseId: 1,
          courseTitle: "Batch 1",
          courseSlug: "batch-1",
          decision: "approved",
        },
        dedupeKey: "b-1",
      },
      {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 11,
          purchaseId: 11,
          courseId: 1,
          courseTitle: "Batch 2",
          courseSlug: "batch-2",
          decision: "declined",
        },
        dedupeKey: "b-2",
      },
    ]);

    expect(ids).toHaveLength(2);
    expect(getUnreadCount(testDb, user.id)).toBe(2);
  });

  it("falls back to /dashboard if target route or course slug is missing", () => {
    const id = writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 99,
        purchaseId: 99,
        courseId: 99,
        courseTitle: "Deleted Course",
        courseSlug: "",
        decision: "approved",
      },
    });

    const recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].id).toBe(id);
    expect(recent[0].deepLink).toBe("/dashboard");
  });

  describe("Transactional Outbox Integration", () => {
    it("creates an email_outbox row with status pending when writing a mandatory notification", () => {
      const id = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 1,
          purchaseId: 10,
          courseId: 1,
          courseTitle: "Test Course",
          courseSlug: "test-course",
          decision: "approved",
          amountRefunded: 5000,
        },
        dedupeKey: "refund-decided:outbox-test-1",
      });

      expect(id).toBeTypeOf("number");

      const outboxRows = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, id!))
        .all();

      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]).toMatchObject({
        notificationId: id,
        status: OutboxStatus.Pending,
        attempts: 0,
        nextAttemptAt: null,
      });
    });

    it("does not create an email_outbox row when notification write is deduplicated", () => {
      const id1 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 2,
          purchaseId: 20,
          courseId: 1,
          courseTitle: "Test Course",
          courseSlug: "test-course",
          decision: "approved",
        },
        dedupeKey: "refund-decided:outbox-dedupe-1",
      });
      expect(id1).toBeTypeOf("number");

      const outboxCountBefore = testDb.select().from(emailOutbox).all().length;

      // Duplicate write with same dedupeKey
      const id2 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 2,
          purchaseId: 20,
          courseId: 1,
          courseTitle: "Test Course",
          courseSlug: "test-course",
          decision: "approved",
        },
        dedupeKey: "refund-decided:outbox-dedupe-1",
      });
      expect(id2).toBeNull();

      const outboxCountAfter = testDb.select().from(emailOutbox).all().length;
      expect(outboxCountAfter).toBe(outboxCountBefore);
    });

    it("rolls back email_outbox row if the transaction is rolled back", () => {
      const totalOutboxBefore = testDb.select().from(emailOutbox).all().length;
      const totalNotificationsBefore = testDb
        .select()
        .from(notifications)
        .all().length;

      expect(() => {
        testDb.transaction((tx) => {
          writeNotification(tx, {
            recipientUserId: user.id,
            type: NotificationType.RefundDecided,
            payload: {
              refundRequestId: 3,
              purchaseId: 30,
              courseId: 1,
              courseTitle: "Test Course",
              courseSlug: "test-course",
              decision: "approved",
            },
            dedupeKey: "refund-decided:rollback-test",
          });

          // Simulate transaction failure
          throw new Error("Simulated rollback");
        });
      }).toThrow("Simulated rollback");

      const totalOutboxAfter = testDb.select().from(emailOutbox).all().length;
      const totalNotificationsAfter = testDb
        .select()
        .from(notifications)
        .all().length;

      expect(totalOutboxAfter).toBe(totalOutboxBefore);
      expect(totalNotificationsAfter).toBe(totalNotificationsBefore);
    });

    it("evaluates default email setting and preferences for optional notifications", () => {
      // TeamLicencePurchased has defaultEmailEnabled: true
      const idTeam = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.TeamLicencePurchased,
        payload: {
          purchaseId: 1,
          courseId: 1,
          courseTitle: "Team Course",
          courseSlug: "team-course",
          seatCount: 5,
          couponCodes: ["C1", "C2"],
        },
      });
      const teamOutbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, idTeam!))
        .all();
      expect(teamOutbox).toHaveLength(1);

      // SeatClaimed has defaultEmailEnabled: false
      const idSeat = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: 1,
          courseId: 1,
          courseTitle: "Team Course",
          courseSlug: "team-course",
          studentName: "Student",
          studentEmail: "student@example.com",
        },
      });
      const seatOutbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, idSeat!))
        .all();
      expect(seatOutbox).toHaveLength(0);

      // User preference overrides: user enables SeatClaimed
      testDb
        .insert(notificationPreferences)
        .values({
          userId: user.id,
          type: NotificationType.SeatClaimed,
          emailEnabled: true,
        })
        .run();

      const idSeatEnabled = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: 2,
          courseId: 1,
          courseTitle: "Team Course",
          courseSlug: "team-course",
          studentName: "Student 2",
          studentEmail: "student2@example.com",
        },
      });
      const seatEnabledOutbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, idSeatEnabled!))
        .all();
      expect(seatEnabledOutbox).toHaveLength(1);
    });
  });
});
