import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  emailOutbox,
  enrollments,
  notificationPreferences,
  notifications,
  NotificationType,
  OutboxStatus,
  purchases,
  teamMembers,
  TeamMemberRole,
  teams,
  UserRole,
  users,
} from "~/db/schema";
import {
  getUnreadCount,
  listRecentNotifications,
  writeNotification,
} from "./notifications.server";
import { drainOutbox } from "./outbox.server";
import type { Email, MailTransport } from "./mailer.server";
import { createTeamPurchase, redeemCoupon } from "./teams.server";

type TestDb = ReturnType<typeof createTestDb>;

function createFakeTransport() {
  const sentEmails: Email[] = [];
  const transport: MailTransport = {
    async send(email: Email) {
      sentEmails.push(email);
    },
  };
  return { transport, sentEmails };
}

describe("Team Licence and Seat Claim domain functions", () => {
  let testDb: TestDb;
  let base: ReturnType<typeof seedBaseData>;
  let teamAdmin: typeof users.$inferSelect;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    teamAdmin = testDb
      .insert(users)
      .values({
        name: "Acme Admin",
        email: "admin@acme.corp",
        role: UserRole.Student,
      })
      .returning()
      .get();
  });

  describe("createTeamPurchase", () => {
    it("notifies Team Admin and creates outbox row by default with seat codes in email", async () => {
      const quantity = 3;
      const amountPaid = 23700;

      const result = createTeamPurchase(testDb, {
        userId: teamAdmin.id,
        courseId: base.course.id,
        amountPaid,
        country: "US",
        quantity,
      });

      expect(result.purchase).toBeDefined();
      expect(result.purchase.userId).toBe(teamAdmin.id);
      expect(result.purchase.courseId).toBe(base.course.id);
      expect(result.purchase.amountPaid).toBe(amountPaid);

      expect(result.team).toBeDefined();
      expect(result.coupons).toHaveLength(quantity);
      const couponCodes = result.coupons.map((c) => c.code);

      // Verify in-app notification
      expect(getUnreadCount(testDb, teamAdmin.id)).toBe(1);
      const recent = listRecentNotifications(testDb, teamAdmin.id);
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe(NotificationType.TeamLicencePurchased);
      expect(recent[0].title).toBe(
        `Team Licence purchased: ${quantity} seats for "${base.course.title}"`
      );
      expect(recent[0].deepLink).toBe("/team");
      expect(recent[0].mandatory).toBe(false);

      // Verify email outbox row created by default (defaultEmailEnabled: true)
      const outboxRows = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, recent[0].id))
        .all();
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe(OutboxStatus.Pending);

      // Drain outbox and verify email content includes seat codes
      const fake = createFakeTransport();
      const drainResult = await drainOutbox({
        db: testDb,
        transport: fake.transport,
      });
      expect(drainResult.sent).toBe(1);
      expect(fake.sentEmails).toHaveLength(1);

      const email = fake.sentEmails[0];
      expect(email.to).toBe(teamAdmin.email);
      expect(email.subject).toContain("Team Licence purchased");
      expect(email.subject).toContain(base.course.title);
      expect(email.body).toContain(base.course.title);
      expect(email.body).toContain("/team");
      // All seat codes must be in the email body
      for (const code of couponCodes) {
        expect(email.body).toContain(code);
      }
    });

    it("respects user preference when Team Admin opted out of email", () => {
      // Opt-out of team_licence_purchased
      testDb
        .insert(notificationPreferences)
        .values({
          userId: teamAdmin.id,
          type: NotificationType.TeamLicencePurchased,
          emailEnabled: false,
        })
        .run();

      const outboxBefore = testDb.select().from(emailOutbox).all().length;

      const result = createTeamPurchase(testDb, {
        userId: teamAdmin.id,
        courseId: base.course.id,
        amountPaid: 15800,
        quantity: 2,
      });

      expect(result.purchase).toBeDefined();

      // In-app notification still created
      expect(getUnreadCount(testDb, teamAdmin.id)).toBe(1);
      const recent = listRecentNotifications(testDb, teamAdmin.id);
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe(NotificationType.TeamLicencePurchased);

      // No email outbox row created
      const outboxAfter = testDb.select().from(emailOutbox).all().length;
      expect(outboxAfter).toBe(outboxBefore);
    });

    it("deduplicates with dedupeKey preventing duplicate notifications or outbox rows", () => {
      const result = createTeamPurchase(testDb, {
        userId: teamAdmin.id,
        courseId: base.course.id,
        amountPaid: 15800,
        quantity: 2,
      });

      const notifCountBefore = testDb.select().from(notifications).all().length;
      const outboxCountBefore = testDb.select().from(emailOutbox).all().length;

      // Simulate re-running notification with same dedupeKey
      const duplicateId = writeNotification(testDb, {
        recipientUserId: teamAdmin.id,
        type: NotificationType.TeamLicencePurchased,
        payload: {
          purchaseId: result.purchase.id,
          courseId: base.course.id,
          courseTitle: base.course.title,
          courseSlug: base.course.slug,
          seatCount: 2,
          couponCodes: result.coupons.map((c) => c.code),
        },
        dedupeKey: `team-licence-purchased:${result.purchase.id}`,
      });

      expect(duplicateId).toBeNull();
      expect(testDb.select().from(notifications).all().length).toBe(notifCountBefore);
      expect(testDb.select().from(emailOutbox).all().length).toBe(outboxCountBefore);
    });
  });

  describe("redeemCoupon", () => {
    let student: typeof users.$inferSelect;
    let coupon: typeof coupons.$inferSelect;

    beforeEach(async () => {
      student = testDb
        .insert(users)
        .values({
          name: "Bob Student",
          email: "bob@student.dev",
          role: UserRole.Student,
        })
        .returning()
        .get();

      const purchaseResult = createTeamPurchase(testDb, {
        userId: teamAdmin.id,
        courseId: base.course.id,
        amountPaid: 7900,
        quantity: 1,
      });

      coupon = purchaseResult.coupons[0];

      // Drain purchase outbox email so outbox is clean for redemption tests
      await drainOutbox({ db: testDb, transport: createFakeTransport().transport });
    });

    it("notifies Team Admin with in-app notification and no email by default", () => {
      const adminUnreadBefore = getUnreadCount(testDb, teamAdmin.id);
      const outboxBefore = testDb.select().from(emailOutbox).all().length;

      const result = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.enrollment.userId).toBe(student.id);
      expect(result.enrollment.courseId).toBe(base.course.id);

      // Verify coupon is marked redeemed in db
      const updatedCoupon = testDb
        .select()
        .from(coupons)
        .where(eq(coupons.id, coupon.id))
        .get();
      expect(updatedCoupon?.redeemedByUserId).toBe(student.id);
      expect(updatedCoupon?.redeemedAt).not.toBeNull();

      // Verify Team Admin received in-app notification
      expect(getUnreadCount(testDb, teamAdmin.id)).toBe(adminUnreadBefore + 1);
      const recent = listRecentNotifications(testDb, teamAdmin.id);
      const seatNotif = recent.find((n) => n.type === NotificationType.SeatClaimed);
      expect(seatNotif).toBeDefined();
      expect(seatNotif?.title).toContain(student.email);
      expect(seatNotif?.deepLink).toBe("/team");
      expect(seatNotif?.mandatory).toBe(false);

      // Verify NO email outbox row was created (default is OFF: false)
      const seatOutbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, seatNotif!.id))
        .all();
      expect(seatOutbox).toHaveLength(0);
      expect(testDb.select().from(emailOutbox).all().length).toBe(outboxBefore);
    });

    it("creates an email outbox row when Team Admin opted in to seat claimed email", async () => {
      // Team admin opts in to seat_claimed
      testDb
        .insert(notificationPreferences)
        .values({
          userId: teamAdmin.id,
          type: NotificationType.SeatClaimed,
          emailEnabled: true,
        })
        .run();

      const result = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const recent = listRecentNotifications(testDb, teamAdmin.id);
      const seatNotif = recent.find((n) => n.type === NotificationType.SeatClaimed);
      expect(seatNotif).toBeDefined();

      // Verify email outbox row was created
      const seatOutbox = testDb
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.notificationId, seatNotif!.id))
        .all();
      expect(seatOutbox).toHaveLength(1);
      expect(seatOutbox[0].status).toBe(OutboxStatus.Pending);

      // Drain outbox and verify email content
      const fake = createFakeTransport();
      const drainResult = await drainOutbox({
        db: testDb,
        transport: fake.transport,
      });
      expect(drainResult.sent).toBe(1);
      expect(fake.sentEmails).toHaveLength(1);

      const email = fake.sentEmails[0];
      expect(email.to).toBe(teamAdmin.email);
      expect(email.subject).toContain("Seat claimed");
      expect(email.subject).toContain(base.course.title);
      expect(email.body).toContain(base.course.title);
      expect(email.body).toContain(student.email);
      expect(email.body).toContain("/team");
    });

    it("notifies Team Admin once (dedupe per coupon)", () => {
      // First redemption succeeds
      const result1 = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });
      expect(result1.ok).toBe(true);

      const notifCountBefore = testDb.select().from(notifications).all().length;

      // Second attempt to redeem same coupon fails
      const result2 = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });
      expect(result2.ok).toBe(false);
      expect(result2).toMatchObject({
        ok: false,
        error: "Coupon has already been redeemed",
      });

      // Deduplication check: attempting to write duplicate notification with same dedupeKey
      const duplicateNotif = writeNotification(testDb, {
        recipientUserId: teamAdmin.id,
        type: NotificationType.SeatClaimed,
        payload: {
          couponId: coupon.id,
          courseId: base.course.id,
          courseTitle: base.course.title,
          courseSlug: base.course.slug,
          studentName: student.name,
          studentEmail: student.email,
        },
        dedupeKey: `seat-claimed:${coupon.id}`,
      });

      expect(duplicateNotif).toBeNull();
      expect(testDb.select().from(notifications).all().length).toBe(notifCountBefore);
    });

    it("prevents redemption if user is already enrolled", () => {
      // First enroll student directly
      testDb
        .insert(enrollments)
        .values({
          userId: student.id,
          courseId: base.course.id,
        })
        .run();

      const result = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: "You are already enrolled in this course",
      });
    });

    it("notifies all admin members of the team that owns the coupon", () => {
      // Add a second admin to the team
      const secondAdmin = testDb
        .insert(users)
        .values({
          name: "Co-Admin",
          email: "coadmin@acme.corp",
          role: UserRole.Student,
        })
        .returning()
        .get();

      testDb
        .insert(teamMembers)
        .values({
          teamId: coupon.teamId,
          userId: secondAdmin.id,
          role: TeamMemberRole.Admin,
        })
        .run();

      const admin1UnreadBefore = getUnreadCount(testDb, teamAdmin.id);
      const admin2UnreadBefore = getUnreadCount(testDb, secondAdmin.id);

      const result = redeemCoupon(testDb, {
        code: coupon.code,
        userId: student.id,
        userCountry: "US",
      });

      expect(result.ok).toBe(true);

      // Both admins receive in-app notification
      expect(getUnreadCount(testDb, teamAdmin.id)).toBe(admin1UnreadBefore + 1);
      expect(getUnreadCount(testDb, secondAdmin.id)).toBe(admin2UnreadBefore + 1);

      const admin1Notifs = listRecentNotifications(testDb, teamAdmin.id);
      const admin2Notifs = listRecentNotifications(testDb, secondAdmin.id);

      expect(admin1Notifs[0].type).toBe(NotificationType.SeatClaimed);
      expect(admin2Notifs[0].type).toBe(NotificationType.SeatClaimed);
    });
  });
});
