import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  comments,
  courses,
  emailOutbox,
  lessons,
  modules,
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
  getUserNotificationPreferences,
  updateUserNotificationPreference,
  notifyOnInstructorReply,
  notifyOnCourseArchived,
  notifyOnCoursePublished,
  purgeOldNotifications,
} from "./notifications.server";

describe("Notification Service", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let user: { id: number; name: string; email: string };
  let instructor: { id: number; name: string; email: string };
  let course: { id: number; title: string; slug: string };

  beforeEach(() => {
    testDb = createTestDb();
    const base = seedBaseData(testDb);
    user = base.user;
    instructor = base.instructor;
    course = base.course;
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

  it("falls back to /dashboard when the course has been deleted from the database (User Story 24)", () => {
    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 10,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        decision: "approved",
      },
      dedupeKey: "refund-decided:deleted-course-test",
    });

    // Course exists: deepLink is to the course
    let recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].deepLink).toBe(`/courses/${course.slug}`);

    // Delete course from database
    testDb.delete(courses).where(eq(courses.id, course.id)).run();

    // Now deepLink should fall back to /dashboard
    recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].deepLink).toBe("/dashboard");
  });

  it("updates deepLink to new slug when course has been renamed (User Story 25)", () => {
    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.RefundDecided,
      payload: {
        refundRequestId: 1,
        purchaseId: 10,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        decision: "approved",
      },
      dedupeKey: "refund-decided:renamed-course-test",
    });

    // Rename the course
    testDb
      .update(courses)
      .set({ slug: "renamed-advanced-course" })
      .where(eq(courses.id, course.id))
      .run();

    const recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].deepLink).toBe("/courses/renamed-advanced-course");
  });

  it("falls back to /dashboard for instructor reply when comment has been deleted (User Story 24)", () => {
    const mod = testDb
      .insert(modules)
      .values({ courseId: course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    const les = testDb
      .insert(lessons)
      .values({ moduleId: mod.id, title: "Lesson 1", position: 1 })
      .returning()
      .get();
    const comment = testDb
      .insert(comments)
      .values({ lessonId: les.id, userId: user.id, body: "My question" })
      .returning()
      .get();

    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.InstructorReply,
      payload: {
        commentId: comment.id,
        parentCommentId: comment.id,
        lessonId: les.id,
        lessonTitle: les.title,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        instructorName: "Instructor",
      },
      dedupeKey: `instructor-reply:${comment.id}`,
    });

    let recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].deepLink).toBe(
      `/courses/${course.slug}/lessons/${les.id}#comment-${comment.id}`
    );

    // Soft-delete the comment
    testDb
      .update(comments)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(comments.id, comment.id))
      .run();

    recent = listRecentNotifications(testDb, user.id);
    expect(recent[0].deepLink).toBe("/dashboard");
  });

  it("falls back to /dashboard for instructor reply when lesson has been deleted (User Story 24)", () => {
    writeNotification(testDb, {
      recipientUserId: user.id,
      type: NotificationType.InstructorReply,
      payload: {
        commentId: 12345,
        parentCommentId: 1,
        lessonId: 99999,
        lessonTitle: "Deleted Lesson",
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        instructorName: "Instructor",
      },
      dedupeKey: "instructor-reply:deleted-lesson-test",
    });

    const recent = listRecentNotifications(testDb, user.id);
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

  describe("Notification Preferences", () => {
    it("returns default preferences filtered by user role", () => {
      const studentPrefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Student,
      ]);

      const studentTypes = studentPrefs.map((p) => p.type);
      expect(studentTypes).toContain(NotificationType.RefundDecided);
      expect(studentTypes).toContain(NotificationType.PurchaseConfirmed);
      expect(studentTypes).toContain(NotificationType.EnrollmentEnded);
      expect(studentTypes).toContain(NotificationType.InstructorReply);

      // Should not contain instructor or admin or team admin types
      expect(studentTypes).not.toContain(NotificationType.RefundRequestRaised);
      expect(studentTypes).not.toContain(NotificationType.CourseArchived);
      expect(studentTypes).not.toContain(NotificationType.CoursePublished);
      expect(studentTypes).not.toContain(NotificationType.TeamLicencePurchased);
      expect(studentTypes).not.toContain(NotificationType.SeatClaimed);

      // Check mandatory vs optional default email states
      const refundDecided = studentPrefs.find(
        (p) => p.type === NotificationType.RefundDecided
      );
      expect(refundDecided?.mandatory).toBe(true);
      expect(refundDecided?.emailEnabled).toBe(true);

      const instructorReply = studentPrefs.find(
        (p) => p.type === NotificationType.InstructorReply
      );
      expect(instructorReply?.mandatory).toBe(false);
      expect(instructorReply?.emailEnabled).toBe(false);
      expect(instructorReply?.defaultEmailEnabled).toBe(false);
      expect(instructorReply?.label).toBe("Someone replies to your comment");
    });

    it("returns union of eligible types for multi-role users", () => {
      const multiPrefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Student,
        "team_admin",
      ]);

      const types = multiPrefs.map((p) => p.type);
      expect(types).toContain(NotificationType.InstructorReply);
      expect(types).toContain(NotificationType.TeamLicencePurchased);
      expect(types).toContain(NotificationType.SeatClaimed);
      expect(types).toContain(NotificationType.RefundDecided);

      const teamLicence = multiPrefs.find(
        (p) => p.type === NotificationType.TeamLicencePurchased
      );
      expect(teamLicence?.mandatory).toBe(false);
      expect(teamLicence?.emailEnabled).toBe(true); // default true for team licence
      expect(teamLicence?.defaultEmailEnabled).toBe(true);
    });

    it("returns only instructor-eligible types for instructor role", () => {
      const instructorPrefs = getUserNotificationPreferences(
        testDb,
        instructor.id,
        [UserRole.Instructor]
      );
      const types = instructorPrefs.map((p) => p.type);
      expect(types).toEqual([
        NotificationType.CourseArchived,
        NotificationType.CoursePublished,
      ]);
    });

    it("returns only admin-eligible types for platform admin role", () => {
      const adminPrefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Admin,
      ]);
      const types = adminPrefs.map((p) => p.type);
      expect(types).toEqual([NotificationType.RefundRequestRaised]);
    });

    it("respects overrides saved in notification_preferences for optional types", () => {
      // Toggle instructor_reply on
      updateUserNotificationPreference(
        testDb,
        user.id,
        NotificationType.InstructorReply,
        true
      );

      const prefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Student,
      ]);
      const instructorReply = prefs.find(
        (p) => p.type === NotificationType.InstructorReply
      );
      expect(instructorReply?.emailEnabled).toBe(true);

      // Toggle instructor_reply back off
      updateUserNotificationPreference(
        testDb,
        user.id,
        NotificationType.InstructorReply,
        false
      );

      const updatedPrefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Student,
      ]);
      const updatedReply = updatedPrefs.find(
        (p) => p.type === NotificationType.InstructorReply
      );
      expect(updatedReply?.emailEnabled).toBe(false);
    });

    it("strictly ignores stale notification_preferences rows for mandatory types", () => {
      // Manually insert a stale row attempting to disable email for a mandatory type
      testDb
        .insert(notificationPreferences)
        .values({
          userId: user.id,
          type: NotificationType.RefundDecided,
          emailEnabled: false,
        })
        .run();

      const prefs = getUserNotificationPreferences(testDb, user.id, [
        UserRole.Student,
      ]);
      const refundDecided = prefs.find(
        (p) => p.type === NotificationType.RefundDecided
      );
      // Mandatory must always be emailEnabled: true
      expect(refundDecided?.emailEnabled).toBe(true);
      expect(refundDecided?.mandatory).toBe(true);

      // Also verify writeNotification ignores the stale row and creates an outbox row
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 1,
          purchaseId: 1,
          courseId: 1,
          courseTitle: "Course",
          courseSlug: "course",
          decision: "approved",
        },
      });

      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(1);
    });

    it("applies preference changes only to future notifications, not existing ones", () => {
      // User has default (false) for seat claimed -> writes notification with no outbox row
      const id1 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: 10,
          courseId: 1,
          courseTitle: "Course",
          courseSlug: "course",
          studentName: "Student",
          studentEmail: "student@example.com",
        },
      });

      expect(
        testDb
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.notificationId, id1!))
          .all()
      ).toHaveLength(0);

      // Now user enables SeatClaimed
      updateUserNotificationPreference(
        testDb,
        user.id,
        NotificationType.SeatClaimed,
        true
      );

      // Previous notification should still have NO outbox row
      expect(
        testDb
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.notificationId, id1!))
          .all()
      ).toHaveLength(0);

      // Future notification DOES create an outbox row
      const id2 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: 11,
          courseId: 1,
          courseTitle: "Course",
          courseSlug: "course",
          studentName: "Student 2",
          studentEmail: "student2@example.com",
        },
      });

      expect(
        testDb
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.notificationId, id2!))
          .all()
      ).toHaveLength(1);
    });
  });

  describe("Instructor Reply Trigger", () => {
    let lesson: { id: number; title: string };
    let parentComment: { id: number; userId: number };

    beforeEach(() => {
      const mod = testDb
        .insert(modules)
        .values({
          courseId: course.id,
          title: "Module 1",
          position: 1,
        })
        .returning()
        .get();

      lesson = testDb
        .insert(lessons)
        .values({
          moduleId: mod.id,
          title: "Lesson 1",
          position: 1,
        })
        .returning()
        .get();

      parentComment = testDb
        .insert(comments)
        .values({
          userId: user.id,
          lessonId: lesson.id,
          parentId: null,
          body: "Student question?",
        })
        .returning()
        .get();
    });

    it("notifies parent comment author in-app when instructor replies", () => {
      const reply = testDb
        .insert(comments)
        .values({
          userId: instructor.id,
          lessonId: lesson.id,
          parentId: parentComment.id,
          body: "Instructor answer.",
        })
        .returning()
        .get();

      const notifId = notifyOnInstructorReply(testDb, reply);
      expect(notifId).toBeTypeOf("number");

      expect(getUnreadCount(testDb, user.id)).toBe(1);
      const recent = listRecentNotifications(testDb, user.id);
      expect(recent[0].type).toBe(NotificationType.InstructorReply);
      expect(recent[0].title).toBe(
        'Test Instructor replied to your comment in "Lesson 1"'
      );
      expect(recent[0].deepLink).toBe(
        `/courses/test-course/lessons/${lesson.id}#comment-${reply.id}`
      );

      // Default email for instructor_reply is false, so outbox should be empty
      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(0);
    });

    it("queues an outbox email when student has opted in to instructor reply emails", () => {
      updateUserNotificationPreference(
        testDb,
        user.id,
        NotificationType.InstructorReply,
        true
      );

      const reply = testDb
        .insert(comments)
        .values({
          userId: instructor.id,
          lessonId: lesson.id,
          parentId: parentComment.id,
          body: "Instructor answer with email opt-in.",
        })
        .returning()
        .get();

      const notifId = notifyOnInstructorReply(testDb, reply);
      expect(notifId).toBeTypeOf("number");

      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe(OutboxStatus.Pending);
    });

    it("notifies when a Platform Admin replies to a comment", () => {
      const admin = testDb
        .insert(users)
        .values({
          name: "Admin User",
          email: "admin@example.com",
          role: UserRole.Admin,
        })
        .returning()
        .get();

      const reply = testDb
        .insert(comments)
        .values({
          userId: admin.id,
          lessonId: lesson.id,
          parentId: parentComment.id,
          body: "Admin answer.",
        })
        .returning()
        .get();

      const notifId = notifyOnInstructorReply(testDb, reply);
      expect(notifId).toBeTypeOf("number");

      const recent = listRecentNotifications(testDb, user.id);
      expect(recent[0].title).toBe(
        'Admin User replied to your comment in "Lesson 1"'
      );
    });

    it("does not notify when a student replies to another student (peer reply)", () => {
      const peerStudent = testDb
        .insert(users)
        .values({
          name: "Peer Student",
          email: "peer@example.com",
          role: UserRole.Student,
        })
        .returning()
        .get();

      const reply = testDb
        .insert(comments)
        .values({
          userId: peerStudent.id,
          lessonId: lesson.id,
          parentId: parentComment.id,
          body: "Peer student comment.",
        })
        .returning()
        .get();

      const notifId = notifyOnInstructorReply(testDb, reply);
      expect(notifId).toBeNull();
      expect(getUnreadCount(testDb, user.id)).toBe(0);
    });

    it("does not notify when instructor replies to their own comment", () => {
      const instructorComment = testDb
        .insert(comments)
        .values({
          userId: instructor.id,
          lessonId: lesson.id,
          parentId: null,
          body: "Instructor's original note.",
        })
        .returning()
        .get();

      const reply = testDb
        .insert(comments)
        .values({
          userId: instructor.id,
          lessonId: lesson.id,
          parentId: instructorComment.id,
          body: "Instructor follow-up.",
        })
        .returning()
        .get();

      const notifId = notifyOnInstructorReply(testDb, reply);
      expect(notifId).toBeNull();
      expect(getUnreadCount(testDb, instructor.id)).toBe(0);
    });

    it("deduplicates multiple notification attempts for the same reply comment", () => {
      const reply = testDb
        .insert(comments)
        .values({
          userId: instructor.id,
          lessonId: lesson.id,
          parentId: parentComment.id,
          body: "Single reply.",
        })
        .returning()
        .get();

      const id1 = notifyOnInstructorReply(testDb, reply);
      expect(id1).toBeTypeOf("number");

      const id2 = notifyOnInstructorReply(testDb, reply);
      expect(id2).toBeNull();

      expect(getUnreadCount(testDb, user.id)).toBe(1);
    });

    it("falls back to /courses/${courseSlug} or /dashboard if lessonId or slug are missing", () => {
      const id1 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.InstructorReply,
        payload: {
          commentId: 10,
          parentCommentId: 1,
          lessonId: 0,
          lessonTitle: "Lesson",
          courseId: 1,
          courseTitle: "Course",
          courseSlug: "test-course",
          instructorName: "Instructor",
        },
      });
      const notif1 = listRecentNotifications(testDb, user.id).find(
        (n) => n.id === id1
      );
      expect(notif1?.deepLink).toBe("/courses/test-course");

      const id2 = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.InstructorReply,
        payload: {
          commentId: 11,
          parentCommentId: 1,
          lessonId: 0,
          lessonTitle: "Lesson",
          courseId: 1,
          courseTitle: "Course",
          courseSlug: "",
          instructorName: "Instructor",
        },
      });
      const notif2 = listRecentNotifications(testDb, user.id).find(
        (n) => n.id === id2
      );
      expect(notif2?.deepLink).toBe("/dashboard");
    });
  });

  describe("Course Archived and Published Triggers", () => {
    it("notifies course instructor when course is archived (mandatory, in-app + email)", () => {
      const fixedDate = "2026-11-14T10:00:00.000Z";
      const notifId = notifyOnCourseArchived(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });

      expect(notifId).toBeTypeOf("number");
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);

      const recent = listRecentNotifications(testDb, instructor.id);
      expect(recent[0].type).toBe(NotificationType.CourseArchived);
      expect(recent[0].title).toBe(
        `Your course "${course.title}" was archived by an admin`
      );
      expect(recent[0].deepLink).toBe(`/courses/${course.slug}`);
      expect(recent[0].mandatory).toBe(true);

      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe(OutboxStatus.Pending);
    });

    it("deduplicates course archived notification with same course id and updatedAt", () => {
      const fixedDate = "2026-11-14T10:00:00.000Z";
      const id1 = notifyOnCourseArchived(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });
      expect(id1).toBeTypeOf("number");

      const id2 = notifyOnCourseArchived(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });
      expect(id2).toBeNull();
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
    });

    it("notifies course instructor when course is published (optional, default off)", () => {
      const fixedDate = "2026-11-14T11:00:00.000Z";
      const notifId = notifyOnCoursePublished(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });

      expect(notifId).toBeTypeOf("number");
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);

      const recent = listRecentNotifications(testDb, instructor.id);
      expect(recent[0].type).toBe(NotificationType.CoursePublished);
      expect(recent[0].title).toBe(`Your course "${course.title}" was published`);
      expect(recent[0].deepLink).toBe(`/courses/${course.slug}`);
      expect(recent[0].mandatory).toBe(false);

      // Default email is off
      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(0);
    });

    it("queues an outbox email when instructor has opted in to course published emails", () => {
      updateUserNotificationPreference(
        testDb,
        instructor.id,
        NotificationType.CoursePublished,
        true
      );

      const fixedDate = "2026-11-14T11:30:00.000Z";
      const notifId = notifyOnCoursePublished(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });

      expect(notifId).toBeTypeOf("number");
      const outbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .all();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe(OutboxStatus.Pending);
    });

    it("deduplicates course published notification with same course id and updatedAt", () => {
      const fixedDate = "2026-11-14T11:00:00.000Z";
      const id1 = notifyOnCoursePublished(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });
      expect(id1).toBeTypeOf("number");

      const id2 = notifyOnCoursePublished(testDb, {
        id: course.id,
        title: course.title,
        slug: course.slug,
        instructorId: instructor.id,
        updatedAt: fixedDate,
      });
      expect(id2).toBeNull();
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
    });
  });

  describe("purgeOldNotifications", () => {
    const NOW = new Date("2026-11-14T12:00:00.000Z");
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("deletes read notifications older than 90 days", () => {
      const ninetyOneDaysAgo = new Date(NOW.getTime() - 91 * DAY_MS);
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 1,
          purchaseId: 1,
          courseId: 1,
          courseTitle: "Old Course",
          courseSlug: "old-course",
          decision: "approved",
        },
      });

      testDb
        .update(notifications)
        .set({
          readAt: ninetyOneDaysAgo.toISOString(),
          createdAt: ninetyOneDaysAgo.toISOString(),
        })
        .where(eq(notifications.id, notifId!))
        .run();

      testDb
        .update(emailOutbox)
        .set({ status: OutboxStatus.Sent, sentAt: ninetyOneDaysAgo.toISOString() })
        .where(eq(emailOutbox.notificationId, notifId!))
        .run();

      const result = purgeOldNotifications({ db: testDb, now: NOW });
      expect(result).toBe(1);

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();
      expect(remaining).toHaveLength(0);
    });

    it("keeps read notifications newer than 90 days", () => {
      const eightyNineDaysAgo = new Date(NOW.getTime() - 89 * DAY_MS);
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 2,
          purchaseId: 2,
          courseId: 1,
          courseTitle: "Recent Course",
          courseSlug: "recent-course",
          decision: "approved",
        },
      });

      testDb
        .update(notifications)
        .set({
          readAt: eightyNineDaysAgo.toISOString(),
          createdAt: eightyNineDaysAgo.toISOString(),
        })
        .where(eq(notifications.id, notifId!))
        .run();

      const result = purgeOldNotifications({ db: testDb, now: NOW });
      expect(result).toBe(0);

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();
      expect(remaining).toHaveLength(1);
    });

    it("keeps unread notifications even if createdAt is older than 90 days", () => {
      const hundredDaysAgo = new Date(NOW.getTime() - 100 * DAY_MS);
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 3,
          purchaseId: 3,
          courseId: 1,
          courseTitle: "Unread Old Course",
          courseSlug: "unread-old-course",
          decision: "approved",
        },
      });

      testDb
        .update(notifications)
        .set({
          readAt: null,
          createdAt: hundredDaysAgo.toISOString(),
        })
        .where(eq(notifications.id, notifId!))
        .run();

      const result = purgeOldNotifications({ db: testDb, now: NOW });
      expect(result).toBe(0);

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();
      expect(remaining).toHaveLength(1);
      expect(getUnreadCount(testDb, user.id)).toBe(1);
    });

    it("keeps notifications with a pending outbox row even if read > 90 days ago", () => {
      const ninetyFiveDaysAgo = new Date(NOW.getTime() - 95 * DAY_MS);
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 4,
          purchaseId: 4,
          courseId: 1,
          courseTitle: "Pending Outbox Course",
          courseSlug: "pending-outbox-course",
          decision: "approved",
        },
      });

      testDb
        .update(notifications)
        .set({
          readAt: ninetyFiveDaysAgo.toISOString(),
          createdAt: ninetyFiveDaysAgo.toISOString(),
        })
        .where(eq(notifications.id, notifId!))
        .run();

      testDb
        .update(emailOutbox)
        .set({ status: OutboxStatus.Pending })
        .where(eq(emailOutbox.notificationId, notifId!))
        .run();

      const result = purgeOldNotifications({ db: testDb, now: NOW });
      expect(result).toBe(0);

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();
      expect(remaining).toHaveLength(1);
    });

    it("deletes read notifications older than 90 days if outbox row is failed", () => {
      const ninetyFiveDaysAgo = new Date(NOW.getTime() - 95 * DAY_MS);
      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 5,
          purchaseId: 5,
          courseId: 1,
          courseTitle: "Failed Outbox Course",
          courseSlug: "failed-outbox-course",
          decision: "approved",
        },
      });

      testDb
        .update(notifications)
        .set({
          readAt: ninetyFiveDaysAgo.toISOString(),
          createdAt: ninetyFiveDaysAgo.toISOString(),
        })
        .where(eq(notifications.id, notifId!))
        .run();

      testDb
        .update(emailOutbox)
        .set({ status: OutboxStatus.Failed })
        .where(eq(emailOutbox.notificationId, notifId!))
        .run();

      const result = purgeOldNotifications({ db: testDb, now: NOW });
      expect(result).toBe(1);

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();
      expect(remaining).toHaveLength(0);
    });
  });
});
