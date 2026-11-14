import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { NotificationType, UserRole, users } from "~/db/schema";
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
});
