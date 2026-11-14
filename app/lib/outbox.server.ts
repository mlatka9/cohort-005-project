import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db as defaultDb } from "~/db";
import * as schema from "~/db/schema";
import {
  emailOutbox,
  notifications,
  NotificationType,
  OutboxStatus,
  users,
} from "~/db/schema";
import { defaultTransport, type MailTransport } from "~/lib/mailer.server";
import { formatPrice } from "~/lib/utils";

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

export const MAX_ATTEMPTS = 5;

// Exponential backoff schedule: 1m, 5m, 30m, 2h, 8h
export const BACKOFF_DELAYS_MS = [
  1 * 60 * 1000, // attempt 1 -> 1 min
  5 * 60 * 1000, // attempt 2 -> 5 min
  30 * 60 * 1000, // attempt 3 -> 30 min
  2 * 60 * 60 * 1000, // attempt 4 -> 2 hours
  8 * 60 * 60 * 1000, // attempt 5 -> 8 hours
];

export function getBackoffDelayMs(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_DELAYS_MS.length - 1));
  return BACKOFF_DELAYS_MS[index];
}

export function calculateBackoff(attempts: number, now: Date = new Date()): string {
  const delayMs = getBackoffDelayMs(attempts);
  return new Date(now.getTime() + delayMs).toISOString();
}

export function renderNotificationEmail(
  type: NotificationType,
  payload: any,
  recipient: { name: string; email: string }
): { subject: string; body: string } {
  switch (type) {
    case NotificationType.RefundDecided: {
      const courseTitle = payload.courseTitle || "Course";
      const decisionNote = payload.decisionNote;
      const amountRefunded = payload.amountRefunded ?? 0;
      const isApproved = payload.decision === "approved";

      const middle = isApproved
        ? [
            `We have approved your refund request for "${courseTitle}".`,
            `${formatPrice(amountRefunded)}, the full amount you paid, is on its way back to you.`,
            ...(decisionNote ? ["", decisionNote] : []),
          ]
        : [
            `We have looked at your refund request for "${courseTitle}" and decided not to refund it.`,
            ...(decisionNote ? ["", decisionNote] : []),
            "",
            "You still have everything you bought. If something changes, you can raise a new refund request.",
          ];

      return {
        subject: `Refund ${payload.decision} — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          ...middle,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.RefundRequestRaised: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Refund requested — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `${payload.buyerName || "A user"} has requested a refund for "${courseTitle}".`,
          `The refund is for ${formatPrice(payload.amountPaid ?? 0)}, the amount paid.`,
          "",
          "Review this refund request in the admin panel: /admin/refunds",
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.PurchaseConfirmed: {
      const courseTitle = payload.courseTitle || "Course";
      const slug = payload.courseSlug || "";
      return {
        subject: `Purchase confirmed — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `Thank you for purchasing "${courseTitle}".`,
          `You can access your course here: /courses/${slug}/welcome`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.EnrollmentEnded: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Enrollment ended — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `Your enrollment in "${courseTitle}" has ended because your refund was approved.`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.CourseArchived: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Course archived — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `Your course "${courseTitle}" was archived by an admin.`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.TeamLicencePurchased: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Team Licence purchased — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `Your purchase of ${payload.seatCount ?? 1} seats for "${courseTitle}" is complete.`,
          "You can distribute seats from your team dashboard: /team",
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.SeatClaimed: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Seat claimed — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `A seat on your Team Licence for "${courseTitle}" has been claimed by ${payload.studentEmail || "a team member"}.`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.InstructorReply: {
      const lessonTitle = payload.lessonTitle || "Lesson";
      const slug = payload.courseSlug || "";
      const lessonId = payload.lessonId || "";
      const commentId = payload.commentId || "";
      return {
        subject: `New reply in "${lessonTitle}"`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `${payload.instructorName || "An instructor"} replied to your comment in "${lessonTitle}".`,
          `View the discussion: /courses/${slug}/lessons/${lessonId}#comment-${commentId}`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    case NotificationType.CoursePublished: {
      const courseTitle = payload.courseTitle || "Course";
      return {
        subject: `Course published — ${courseTitle}`,
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          `Your course "${courseTitle}" has been published and is now live.`,
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }

    default: {
      return {
        subject: "Notification from Cadence",
        body: [
          `Hi ${recipient.name || "there"},`,
          "",
          "You have a new notification on Cadence.",
          "",
          "— The Cadence team",
        ].join("\n"),
      };
    }
  }
}

export interface DrainOptions {
  db?: Queryable;
  transport?: MailTransport;
  now?: Date;
}

export interface DrainResult {
  sent: number;
  retried: number;
  failed: number;
}

export async function drainOutbox(options?: DrainOptions): Promise<DrainResult> {
  const database = options?.db ?? defaultDb;
  const transport = options?.transport ?? defaultTransport();
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();

  const dueRows = database
    .select({
      id: emailOutbox.id,
      notificationId: emailOutbox.notificationId,
      attempts: emailOutbox.attempts,
      nextAttemptAt: emailOutbox.nextAttemptAt,
    })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, OutboxStatus.Pending),
        or(isNull(emailOutbox.nextAttemptAt), lte(emailOutbox.nextAttemptAt, nowIso))
      )
    )
    .orderBy(asc(emailOutbox.createdAt), asc(emailOutbox.id))
    .all();

  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const row of dueRows) {
    const notif = database
      .select({
        id: notifications.id,
        recipientUserId: notifications.recipientUserId,
        type: notifications.type,
        payload: notifications.payload,
      })
      .from(notifications)
      .where(eq(notifications.id, row.notificationId))
      .get();

    if (!notif) {
      database
        .update(emailOutbox)
        .set({
          status: OutboxStatus.Failed,
          lastError: "Notification row not found",
        })
        .where(eq(emailOutbox.id, row.id))
        .run();
      console.error(`Outbox email ${row.id} failed: Notification not found`);
      failed++;
      continue;
    }

    const recipient = database
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, notif.recipientUserId))
      .get();

    if (!recipient || !recipient.email) {
      database
        .update(emailOutbox)
        .set({
          status: OutboxStatus.Failed,
          lastError: "Recipient user or email not found",
        })
        .where(eq(emailOutbox.id, row.id))
        .run();
      console.error(
        `Outbox email ${row.id} failed: Recipient user ${notif.recipientUserId} not found or missing email`
      );
      failed++;
      continue;
    }

    let payload: any = {};
    try {
      payload = JSON.parse(notif.payload);
    } catch {
      payload = {};
    }

    const email = renderNotificationEmail(notif.type, payload, recipient);

    try {
      await transport.send({
        to: recipient.email,
        subject: email.subject,
        body: email.body,
      });

      database
        .update(emailOutbox)
        .set({
          status: OutboxStatus.Sent,
          sentAt: nowIso,
          lastError: null,
        })
        .where(eq(emailOutbox.id, row.id))
        .run();

      sent++;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;

      if (nextAttempts >= MAX_ATTEMPTS) {
        database
          .update(emailOutbox)
          .set({
            status: OutboxStatus.Failed,
            attempts: nextAttempts,
            lastError: errorMessage,
          })
          .where(eq(emailOutbox.id, row.id))
          .run();

        console.error(
          `Outbox email ${row.id} permanently failed after ${nextAttempts} attempts: ${errorMessage}`
        );
        failed++;
      } else {
        const nextAttemptAt = calculateBackoff(nextAttempts, now);
        database
          .update(emailOutbox)
          .set({
            attempts: nextAttempts,
            nextAttemptAt,
            lastError: errorMessage,
          })
          .where(eq(emailOutbox.id, row.id))
          .run();

        retried++;
      }
    }
  }

  return { sent, retried, failed };
}

export async function triggerOutboxDrain(options?: DrainOptions): Promise<void> {
  try {
    await drainOutbox(options);
  } catch (err) {
    console.error("Failed to drain outbox:", err);
  }
}

declare global {
  var __cadenceOutboxDrainInterval: NodeJS.Timeout | undefined;
}

export function initOutboxDrain(intervalMs = 60_000) {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (!globalThis.__cadenceOutboxDrainInterval) {
    globalThis.__cadenceOutboxDrainInterval = setInterval(() => {
      triggerOutboxDrain().catch((err) => {
        console.error("Error in background outbox drain interval:", err);
      });
    }, intervalMs);

    if (globalThis.__cadenceOutboxDrainInterval.unref) {
      globalThis.__cadenceOutboxDrainInterval.unref();
    }
  }
}

initOutboxDrain();
