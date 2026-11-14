import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  emailOutbox,
  notifications,
  NotificationType,
  OutboxStatus,
  UserRole,
  users,
} from "~/db/schema";
import { writeNotification } from "~/lib/notifications.server";
import {
  calculateBackoff,
  drainOutbox,
  MAX_ATTEMPTS,
  triggerOutboxDrain,
  purgeOldNotifications,
} from "./outbox.server";
import type { Email, MailTransport } from "./mailer.server";

type TestDb = ReturnType<typeof createTestDb>;

describe("Outbox Drain and Backoff", () => {
  let testDb: TestDb;
  let user: { id: number; name: string; email: string };
  const BASE_TIME = new Date("2026-11-14T12:00:00.000Z");

  beforeEach(() => {
    testDb = createTestDb();
    const base = seedBaseData(testDb);
    user = base.user;
  });

  function createFakeTransport() {
    const sentEmails: Email[] = [];
    let shouldFail = false;
    let failureError = new Error("Transport send failed (e.g. 500 error)");

    const transport: MailTransport = {
      async send(email: Email) {
        if (shouldFail) {
          throw failureError;
        }
        sentEmails.push(email);
      },
    };

    return {
      transport,
      sentEmails,
      setShouldFail(fail: boolean, error?: Error) {
        shouldFail = fail;
        if (error) failureError = error;
      },
    };
  }

  describe("calculateBackoff", () => {
    it("calculates exponential backoff progression", () => {
      const t0 = new Date("2026-11-14T12:00:00.000Z");

      // Attempt 1 -> 1 min
      const b1 = new Date(calculateBackoff(1, t0)).getTime();
      expect(b1 - t0.getTime()).toBe(60 * 1000);

      // Attempt 2 -> 5 min
      const b2 = new Date(calculateBackoff(2, t0)).getTime();
      expect(b2 - t0.getTime()).toBe(5 * 60 * 1000);

      // Attempt 3 -> 30 min
      const b3 = new Date(calculateBackoff(3, t0)).getTime();
      expect(b3 - t0.getTime()).toBe(30 * 60 * 1000);

      // Attempt 4 -> 2 hours
      const b4 = new Date(calculateBackoff(4, t0)).getTime();
      expect(b4 - t0.getTime()).toBe(2 * 60 * 60 * 1000);

      // Attempt 5 -> 8 hours
      const b5 = new Date(calculateBackoff(5, t0)).getTime();
      expect(b5 - t0.getTime()).toBe(8 * 60 * 60 * 1000);
    });
  });

  describe("drainOutbox with fake MailTransport", () => {
    it("drains pending rows and marks them sent", async () => {
      const fake = createFakeTransport();

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 1,
          purchaseId: 10,
          courseId: 1,
          courseTitle: "TypeScript Mastery",
          courseSlug: "typescript-mastery",
          decision: "approved",
          decisionNote: "Approved per policy",
          amountRefunded: 7900,
        },
      });

      expect(notifId).toBeTypeOf("number");

      const result = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: BASE_TIME,
      });

      expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(fake.sentEmails).toHaveLength(1);
      expect(fake.sentEmails[0]).toMatchObject({
        to: user.email,
        subject: "Refund approved — TypeScript Mastery",
      });
      expect(fake.sentEmails[0].body).toContain("We have approved your refund request");
      expect(fake.sentEmails[0].body).toContain("$79.00");
      expect(fake.sentEmails[0].body).toContain("Approved per policy");

      // Verify row in database is now 'sent'
      const outboxRow = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();

      expect(outboxRow).toMatchObject({
        status: OutboxStatus.Sent,
        sentAt: BASE_TIME.toISOString(),
        lastError: null,
      });
    });

    it("drains course archived email to instructor", async () => {
      const fake = createFakeTransport();

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.CourseArchived,
        payload: {
          courseId: 10,
          courseTitle: "Fullstack React",
          courseSlug: "fullstack-react",
          archivedAt: BASE_TIME.toISOString(),
        },
      });

      expect(notifId).toBeTypeOf("number");

      const result = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: BASE_TIME,
      });

      expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(fake.sentEmails).toHaveLength(1);
      expect(fake.sentEmails[0]).toMatchObject({
        to: user.email,
        subject: "Course archived — Fullstack React",
      });
      expect(fake.sentEmails[0].body).toContain(
        'Your course "Fullstack React" was archived by an admin.'
      );
    });

    it("drains course published email to instructor when opted in", async () => {
      const fake = createFakeTransport();

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.CoursePublished,
        payload: {
          courseId: 10,
          courseTitle: "Fullstack React",
          courseSlug: "fullstack-react",
          publishedAt: BASE_TIME.toISOString(),
        },
      });

      // CoursePublished default email is false, so outbox row is null initially
      expect(
        testDb
          .select()
          .from(emailOutbox)
          .where(eq(emailOutbox.notificationId, notifId!))
          .all()
      ).toHaveLength(0);

      // Explicitly insert outbox row as if opted in
      testDb
        .insert(emailOutbox)
        .values({
          notificationId: notifId!,
          status: OutboxStatus.Pending,
          attempts: 0,
        })
        .run();

      const result = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: BASE_TIME,
      });

      expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(fake.sentEmails).toHaveLength(1);
      expect(fake.sentEmails[0]).toMatchObject({
        to: user.email,
        subject: "Course published — Fullstack React",
      });
      expect(fake.sentEmails[0].body).toContain(
        'Your course "Fullstack React" has been published and is now live.'
      );
    });

    it("ignores pending rows whose nextAttemptAt is in the future", async () => {
      const fake = createFakeTransport();

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 2,
          purchaseId: 20,
          courseId: 1,
          courseTitle: "TypeScript Mastery",
          courseSlug: "typescript-mastery",
          decision: "approved",
        },
      });

      // Set nextAttemptAt to 10 minutes in future
      const futureTime = new Date(BASE_TIME.getTime() + 10 * 60 * 1000);
      testDb
        .update(emailOutbox)
        .set({ nextAttemptAt: futureTime.toISOString() })
        .where(eq(emailOutbox.notificationId, notifId!))
        .run();

      const result = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: BASE_TIME,
      });

      expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
      expect(fake.sentEmails).toHaveLength(0);

      // When now advances past nextAttemptAt, it should be drained
      const afterFuture = new Date(futureTime.getTime() + 1000);
      const result2 = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: afterFuture,
      });

      expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(fake.sentEmails).toHaveLength(1);
    });

    it("retries with backoff on failure and marks failed when attempts exhausted", async () => {
      const fake = createFakeTransport();
      fake.setShouldFail(true, new Error("503 Service Unavailable"));

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 3,
          purchaseId: 30,
          courseId: 1,
          courseTitle: "TypeScript Mastery",
          courseSlug: "typescript-mastery",
          decision: "declined",
          decisionNote: "Over the limit",
        },
      });

      let currentTime = BASE_TIME;

      // Attempt 1: fails -> retried: 1, attempts: 1, nextAttemptAt: +1m
      const res1 = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: currentTime,
      });
      expect(res1).toEqual({ sent: 0, retried: 1, failed: 0 });

      let row = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();
      expect(row?.status).toBe(OutboxStatus.Pending);
      expect(row?.attempts).toBe(1);
      expect(row?.lastError).toContain("503 Service Unavailable");
      expect(new Date(row!.nextAttemptAt!).getTime() - currentTime.getTime()).toBe(60 * 1000);

      // Advance clock to attempt 2
      currentTime = new Date(row!.nextAttemptAt!);
      const res2 = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: currentTime,
      });
      expect(res2).toEqual({ sent: 0, retried: 1, failed: 0 });
      row = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();
      expect(row?.attempts).toBe(2);
      expect(new Date(row!.nextAttemptAt!).getTime() - currentTime.getTime()).toBe(5 * 60 * 1000);

      // Advance clock to attempt 3
      currentTime = new Date(row!.nextAttemptAt!);
      await drainOutbox({ db: testDb, transport: fake.transport, now: currentTime });
      row = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();
      expect(row?.attempts).toBe(3);

      // Advance clock to attempt 4
      currentTime = new Date(row!.nextAttemptAt!);
      await drainOutbox({ db: testDb, transport: fake.transport, now: currentTime });
      row = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();
      expect(row?.attempts).toBe(4);

      // Advance clock to attempt 5 (exhaustion)
      currentTime = new Date(row!.nextAttemptAt!);
      const res5 = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: currentTime,
      });
      expect(res5).toEqual({ sent: 0, retried: 0, failed: 1 });

      row = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, notifId!))
        .get();
      expect(row?.status).toBe(OutboxStatus.Failed);
      expect(row?.attempts).toBe(5);
      expect(row?.lastError).toContain("503 Service Unavailable");
      expect(consoleErrorSpy).toHaveBeenCalled();

      // Subsequent drain will not retry failed row
      currentTime = new Date(currentTime.getTime() + 1000);
      const res6 = await drainOutbox({
        db: testDb,
        transport: fake.transport,
        now: currentTime,
      });
      expect(res6).toEqual({ sent: 0, retried: 0, failed: 0 });

      consoleErrorSpy.mockRestore();
    });
  });

  describe("triggerOutboxDrain periodic purge cycle", () => {
    it("purges read notifications older than 90 days during drain cycle", async () => {
      const fake = createFakeTransport();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const ninetyOneDaysAgo = new Date(BASE_TIME.getTime() - 91 * DAY_MS);

      const notifId = writeNotification(testDb, {
        recipientUserId: user.id,
        type: NotificationType.RefundDecided,
        payload: {
          refundRequestId: 99,
          purchaseId: 99,
          courseId: 1,
          courseTitle: "Purge Test Course",
          courseSlug: "purge-test-course",
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

      await triggerOutboxDrain({
        db: testDb,
        transport: fake.transport,
        now: BASE_TIME,
      });

      const remaining = testDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, notifId!))
        .all();

      expect(remaining).toHaveLength(0);
    });
  });
});
