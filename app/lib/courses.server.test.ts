import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  courses,
  CourseStatus,
  emailOutbox,
  notifications,
  NotificationType,
  OutboxStatus,
  users,
  UserRole,
} from "~/db/schema";
import {
  getUnreadCount,
  listRecentNotifications,
  updateUserNotificationPreference,
} from "~/lib/notifications.server";
import { updateCourseStatus } from "~/lib/courses.server";

describe("updateCourseStatus", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let base: ReturnType<typeof seedBaseData>;
  let instructor: typeof users.$inferSelect;
  let admin: typeof users.$inferSelect;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    instructor = base.instructor;

    admin = testDb
      .insert(users)
      .values({
        name: "Admin User",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
  });

  describe("archiving a course", () => {
    it("creates one notification and outbox row for the instructor", () => {
      const unreadBefore = getUnreadCount(testDb, instructor.id);
      expect(unreadBefore).toBe(0);

      const fixedDate = new Date("2026-11-14T10:00:00.000Z");

      const result = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Archived,
        { now: fixedDate }
      );

      expect(result.course.status).toBe(CourseStatus.Archived);
      expect(result.course.updatedAt).toBe(fixedDate.toISOString());
      expect(result.notificationId).toBeTypeOf("number");

      // Verify course status in database
      const courseInDb = testDb
        .select()
        .from(courses)
        .where(eq(courses.id, base.course.id))
        .get();
      expect(courseInDb?.status).toBe(CourseStatus.Archived);
      expect(courseInDb?.updatedAt).toBe(fixedDate.toISOString());

      // Verify in-app notification
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
      const recent = listRecentNotifications(testDb, instructor.id);
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe(result.notificationId);
      expect(recent[0].type).toBe(NotificationType.CourseArchived);
      expect(recent[0].title).toBe(
        `Your course "${base.course.title}" was archived by an admin`
      );
      expect(recent[0].deepLink).toBe(`/courses/${base.course.slug}`);
      expect(recent[0].mandatory).toBe(true);

      // Verify raw notification row & payload
      const notifRow = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, result.notificationId!))
        .get();
      expect(notifRow).toBeDefined();
      expect(notifRow?.recipientUserId).toBe(instructor.id);
      expect(notifRow?.dedupeKey).toBe(
        `course-archived:${base.course.id}:${fixedDate.toISOString()}`
      );

      const payload = JSON.parse(notifRow!.payload);
      expect(payload).toEqual({
        courseId: base.course.id,
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
        archivedAt: fixedDate.toISOString(),
      });

      // Verify email outbox row (Mandatory: always queued)
      const outboxRows = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, result.notificationId!))
        .all();
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]).toMatchObject({
        notificationId: result.notificationId,
        status: OutboxStatus.Pending,
        attempts: 0,
      });
    });
  });

  describe("publishing a course", () => {
    beforeEach(() => {
      testDb
        .update(courses)
        .set({ status: CourseStatus.Draft })
        .where(eq(courses.id, base.course.id))
        .run();
    });

    it("creates one notification for the instructor with no outbox row by default (opt-out)", () => {
      const unreadBefore = getUnreadCount(testDb, instructor.id);
      expect(unreadBefore).toBe(0);

      const fixedDate = new Date("2026-11-14T11:00:00.000Z");

      const result = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: fixedDate }
      );

      expect(result.course.status).toBe(CourseStatus.Published);
      expect(result.course.updatedAt).toBe(fixedDate.toISOString());
      expect(result.notificationId).toBeTypeOf("number");

      // Verify course status in database
      const courseInDb = testDb
        .select()
        .from(courses)
        .where(eq(courses.id, base.course.id))
        .get();
      expect(courseInDb?.status).toBe(CourseStatus.Published);

      // Verify in-app notification
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
      const recent = listRecentNotifications(testDb, instructor.id);
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe(result.notificationId);
      expect(recent[0].type).toBe(NotificationType.CoursePublished);
      expect(recent[0].title).toBe(
        `Your course "${base.course.title}" was published`
      );
      expect(recent[0].deepLink).toBe(`/courses/${base.course.slug}`);
      expect(recent[0].mandatory).toBe(false);

      // Verify raw notification row & payload
      const notifRow = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, result.notificationId!))
        .get();
      expect(notifRow).toBeDefined();
      expect(notifRow?.recipientUserId).toBe(instructor.id);
      expect(notifRow?.dedupeKey).toBe(
        `course-published:${base.course.id}:${fixedDate.toISOString()}`
      );

      const payload = JSON.parse(notifRow!.payload);
      expect(payload).toEqual({
        courseId: base.course.id,
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
        publishedAt: fixedDate.toISOString(),
      });

      // Verify no outbox row by default (Optional: email default OFF)
      const outboxRows = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, result.notificationId!))
        .all();
      expect(outboxRows).toHaveLength(0);
    });

    it("creates an outbox row when instructor has opted in to course published emails", () => {
      updateUserNotificationPreference(
        testDb,
        instructor.id,
        NotificationType.CoursePublished,
        true
      );

      const fixedDate = new Date("2026-11-14T11:30:00.000Z");

      const result = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: fixedDate }
      );

      expect(result.notificationId).toBeTypeOf("number");

      // Verify outbox row created when opted in
      const outboxRows = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, result.notificationId!))
        .all();
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]).toMatchObject({
        notificationId: result.notificationId,
        status: OutboxStatus.Pending,
        attempts: 0,
      });
    });
  });

  describe("deduplication and re-notifying", () => {
    it("prevents duplicate notification and outbox row on double-submit when archiving", () => {
      const t1 = new Date("2026-11-14T12:00:00.000Z");

      // First submit
      const res1 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Archived,
        { now: t1 }
      );
      expect(res1.notificationId).toBeTypeOf("number");
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);

      const notifCount1 = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, instructor.id))
        .all().length;
      const outboxCount1 = testDb.select().from(emailOutbox).all().length;
      expect(notifCount1).toBe(1);
      expect(outboxCount1).toBe(1);

      // Second submit (double-submit)
      const res2 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Archived,
        { now: t1 }
      );
      expect(res2.notificationId).toBeNull();

      const notifCount2 = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, instructor.id))
        .all().length;
      const outboxCount2 = testDb.select().from(emailOutbox).all().length;
      expect(notifCount2).toBe(1);
      expect(outboxCount2).toBe(1);
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
    });

    it("prevents duplicate notification on double-submit when publishing", () => {
      testDb
        .update(courses)
        .set({ status: CourseStatus.Draft })
        .where(eq(courses.id, base.course.id))
        .run();

      const t1 = new Date("2026-11-14T12:00:00.000Z");

      // First submit
      const res1 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: t1 }
      );
      expect(res1.notificationId).toBeTypeOf("number");
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);

      // Second submit (double-submit)
      const res2 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: t1 }
      );
      expect(res2.notificationId).toBeNull();

      const notifCount = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, instructor.id))
        .all().length;
      expect(notifCount).toBe(1);
      expect(getUnreadCount(testDb, instructor.id)).toBe(1);
    });

    it("notifies again when re-archived later after status change", () => {
      const t1 = new Date("2026-11-14T12:00:00.000Z");
      const t2 = new Date("2026-11-14T13:00:00.000Z");
      const t3 = new Date("2026-11-14T14:00:00.000Z");

      // 1. Initial archive
      const res1 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Archived,
        { now: t1 }
      );
      expect(res1.notificationId).toBeTypeOf("number");

      // 2. Un-archive to Draft
      const res2 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Draft,
        { now: t2 }
      );
      expect(res2.notificationId).toBeNull();

      // 3. Re-archive later
      const res3 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Archived,
        { now: t3 }
      );
      expect(res3.notificationId).toBeTypeOf("number");
      expect(res3.notificationId).not.toBe(res1.notificationId);

      // Assert two distinct notifications were created
      const notifs = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, instructor.id))
        .all();
      expect(notifs).toHaveLength(2);
      expect(notifs[0].dedupeKey).toBe(
        `course-archived:${base.course.id}:${t1.toISOString()}`
      );
      expect(notifs[1].dedupeKey).toBe(
        `course-archived:${base.course.id}:${t3.toISOString()}`
      );
      expect(getUnreadCount(testDb, instructor.id)).toBe(2);

      // Assert two outbox rows were created
      const outbox = testDb.select().from(emailOutbox).all();
      expect(outbox).toHaveLength(2);
    });

    it("notifies again when re-published later after status change", () => {
      testDb
        .update(courses)
        .set({ status: CourseStatus.Draft })
        .where(eq(courses.id, base.course.id))
        .run();

      const t1 = new Date("2026-11-14T12:00:00.000Z");
      const t2 = new Date("2026-11-14T13:00:00.000Z");
      const t3 = new Date("2026-11-14T14:00:00.000Z");

      // 1. Initial publish
      const res1 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: t1 }
      );
      expect(res1.notificationId).toBeTypeOf("number");

      // 2. Archive or unpublish
      const res2 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Draft,
        { now: t2 }
      );
      expect(res2.notificationId).toBeNull();

      // 3. Re-publish later
      const res3 = updateCourseStatus(
        testDb,
        base.course.id,
        CourseStatus.Published,
        { now: t3 }
      );
      expect(res3.notificationId).toBeTypeOf("number");
      expect(res3.notificationId).not.toBe(res1.notificationId);

      // Assert two distinct notifications were created
      const notifs = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.recipientUserId, instructor.id))
        .all();
      expect(notifs).toHaveLength(2);
      expect(notifs[0].dedupeKey).toBe(
        `course-published:${base.course.id}:${t1.toISOString()}`
      );
      expect(notifs[1].dedupeKey).toBe(
        `course-published:${base.course.id}:${t3.toISOString()}`
      );
      expect(getUnreadCount(testDb, instructor.id)).toBe(2);
    });
  });
});
