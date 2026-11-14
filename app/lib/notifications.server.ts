import { and, desc, eq, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db as defaultDb } from "~/db";
import * as schema from "~/db/schema";
import {
  emailOutbox,
  notificationPreferences,
  notifications,
  NotificationType,
  OutboxStatus,
  UserRole,
} from "~/db/schema";
import { triggerOutboxDrain } from "~/lib/outbox.server";

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

// ─── Payloads ───

export interface RefundRequestRaisedPayload {
  refundRequestId: number;
  purchaseId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  buyerName: string;
  amountPaid: number;
}

export interface RefundDecidedPayload {
  refundRequestId: number;
  purchaseId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  decision: "approved" | "declined";
  decisionNote?: string | null;
  amountRefunded?: number;
}

export interface PurchaseConfirmedPayload {
  purchaseId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  amountPaid: number;
}

export interface EnrollmentEndedPayload {
  purchaseId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
}

export interface CourseArchivedPayload {
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  archivedAt: string;
}

export interface TeamLicencePurchasedPayload {
  purchaseId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  seatCount: number;
  couponCodes: string[];
}

export interface SeatClaimedPayload {
  couponId: number;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  studentName: string;
  studentEmail: string;
}

export interface InstructorReplyPayload {
  commentId: number;
  parentCommentId: number;
  lessonId: number;
  lessonTitle: string;
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  instructorName: string;
}

export interface CoursePublishedPayload {
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  publishedAt: string;
}

export type NotificationPayloadMap = {
  [NotificationType.RefundRequestRaised]: RefundRequestRaisedPayload;
  [NotificationType.RefundDecided]: RefundDecidedPayload;
  [NotificationType.PurchaseConfirmed]: PurchaseConfirmedPayload;
  [NotificationType.EnrollmentEnded]: EnrollmentEndedPayload;
  [NotificationType.CourseArchived]: CourseArchivedPayload;
  [NotificationType.TeamLicencePurchased]: TeamLicencePurchasedPayload;
  [NotificationType.SeatClaimed]: SeatClaimedPayload;
  [NotificationType.InstructorReply]: InstructorReplyPayload;
  [NotificationType.CoursePublished]: CoursePublishedPayload;
};

// ─── Metadata Registry ───

export type NotificationCategory = "mandatory" | "optional";

export interface NotificationTypeMeta<T extends NotificationType = NotificationType> {
  type: T;
  category: NotificationCategory;
  eligibleRoles: UserRole[];
  defaultEmailEnabled: boolean;
  title: (payload: NotificationPayloadMap[T]) => string;
  deepLink: (payload: NotificationPayloadMap[T]) => string;
  fallbackLink: string;
}

export const NOTIFICATION_REGISTRY: {
  [K in NotificationType]: NotificationTypeMeta<K>;
} = {
  [NotificationType.RefundRequestRaised]: {
    type: NotificationType.RefundRequestRaised,
    category: "mandatory",
    eligibleRoles: [UserRole.Admin],
    defaultEmailEnabled: true,
    title: (p) => `Refund request raised for "${p.courseTitle}"`,
    deepLink: () => "/admin/refunds",
    fallbackLink: "/dashboard",
  },
  [NotificationType.RefundDecided]: {
    type: NotificationType.RefundDecided,
    category: "mandatory",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: true,
    title: (p) => `Your refund for "${p.courseTitle}" was ${p.decision}`,
    deepLink: (p) => (p.courseSlug ? `/courses/${p.courseSlug}` : "/dashboard"),
    fallbackLink: "/dashboard",
  },
  [NotificationType.PurchaseConfirmed]: {
    type: NotificationType.PurchaseConfirmed,
    category: "mandatory",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: true,
    title: (p) => `Purchase confirmed: "${p.courseTitle}"`,
    deepLink: (p) =>
      p.courseSlug ? `/courses/${p.courseSlug}/welcome` : "/dashboard",
    fallbackLink: "/dashboard",
  },
  [NotificationType.EnrollmentEnded]: {
    type: NotificationType.EnrollmentEnded,
    category: "mandatory",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: true,
    title: (p) => `Your enrollment in "${p.courseTitle}" has ended`,
    deepLink: (p) => (p.courseSlug ? `/courses/${p.courseSlug}` : "/dashboard"),
    fallbackLink: "/dashboard",
  },
  [NotificationType.CourseArchived]: {
    type: NotificationType.CourseArchived,
    category: "mandatory",
    eligibleRoles: [UserRole.Instructor],
    defaultEmailEnabled: true,
    title: (p) => `Your course "${p.courseTitle}" was archived by an admin`,
    deepLink: (p) => (p.courseSlug ? `/courses/${p.courseSlug}` : "/dashboard"),
    fallbackLink: "/dashboard",
  },
  [NotificationType.TeamLicencePurchased]: {
    type: NotificationType.TeamLicencePurchased,
    category: "optional",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: true,
    title: (p) =>
      `Team Licence purchased: ${p.seatCount} seats for "${p.courseTitle}"`,
    deepLink: () => "/team",
    fallbackLink: "/dashboard",
  },
  [NotificationType.SeatClaimed]: {
    type: NotificationType.SeatClaimed,
    category: "optional",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: false,
    title: (p) => `Seat claimed on your Team Licence by ${p.studentEmail}`,
    deepLink: () => "/team",
    fallbackLink: "/dashboard",
  },
  [NotificationType.InstructorReply]: {
    type: NotificationType.InstructorReply,
    category: "optional",
    eligibleRoles: [UserRole.Student],
    defaultEmailEnabled: false,
    title: (p) =>
      `${p.instructorName} replied to your comment in "${p.lessonTitle}"`,
    deepLink: (p) =>
      p.courseSlug && p.lessonId
        ? `/courses/${p.courseSlug}/lessons/${p.lessonId}#comment-${p.commentId}`
        : "/dashboard",
    fallbackLink: "/dashboard",
  },
  [NotificationType.CoursePublished]: {
    type: NotificationType.CoursePublished,
    category: "optional",
    eligibleRoles: [UserRole.Instructor],
    defaultEmailEnabled: false,
    title: (p) => `Your course "${p.courseTitle}" was published`,
    deepLink: (p) => (p.courseSlug ? `/courses/${p.courseSlug}` : "/dashboard"),
    fallbackLink: "/dashboard",
  },
};

// ─── Formatted View ───

export interface FormattedNotification {
  id: number;
  recipientUserId: number;
  type: NotificationType;
  title: string;
  deepLink: string;
  read: boolean;
  readAt: string | null;
  createdAt: string;
  relativeTime: string;
  mandatory: boolean;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo`;
}

export function formatNotification(
  row: typeof notifications.$inferSelect,
  now: Date = new Date()
): FormattedNotification {
  const meta = NOTIFICATION_REGISTRY[row.type];
  let payload: any = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }

  let title = "Notification";
  let deepLink = meta?.fallbackLink ?? "/dashboard";

  if (meta) {
    try {
      title = meta.title(payload);
    } catch {
      title = "Notification";
    }

    try {
      deepLink = meta.deepLink(payload);
    } catch {
      deepLink = meta.fallbackLink;
    }
  }

  const createdAtDate = new Date(row.createdAt);
  const isRead = row.readAt !== null;

  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    type: row.type,
    title,
    deepLink,
    read: isRead,
    readAt: row.readAt,
    createdAt: row.createdAt,
    relativeTime: formatRelativeTime(createdAtDate, now),
    mandatory: meta?.category === "mandatory",
  };
}

// ─── Notification Operations ───

export interface CreateNotificationParams<
  T extends NotificationType = NotificationType,
> {
  recipientUserId: number;
  type: T;
  payload: NotificationPayloadMap[T];
  dedupeKey?: string | null;
}

export function writeNotification<T extends NotificationType>(
  tx: Queryable,
  params: CreateNotificationParams<T>
): number | null {
  const payloadString = JSON.stringify(params.payload);
  const now = new Date().toISOString();

  const result = tx
    .insert(notifications)
    .values({
      recipientUserId: params.recipientUserId,
      type: params.type,
      payload: payloadString,
      createdAt: now,
      dedupeKey: params.dedupeKey ?? null,
    })
    .onConflictDoNothing({
      target: [notifications.recipientUserId, notifications.dedupeKey],
    })
    .returning({ id: notifications.id })
    .get();

  if (!result) {
    return null;
  }

  const meta = NOTIFICATION_REGISTRY[params.type];
  let shouldEmail = false;

  if (meta) {
    if (meta.category === "mandatory") {
      shouldEmail = true;
    } else if (meta.category === "optional") {
      const pref = tx
        .select({ emailEnabled: notificationPreferences.emailEnabled })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.userId, params.recipientUserId),
            eq(notificationPreferences.type, params.type)
          )
        )
        .get();

      shouldEmail =
        pref !== undefined ? pref.emailEnabled : meta.defaultEmailEnabled;
    }
  }

  if (shouldEmail) {
    tx.insert(emailOutbox)
      .values({
        notificationId: result.id,
        status: OutboxStatus.Pending,
        attempts: 0,
        createdAt: now,
      })
      .run();

    if (process.env.NODE_ENV !== "test" && typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        triggerOutboxDrain().catch(() => {});
      });
    }
  }

  return result.id;
}

export function writeNotifications<T extends NotificationType>(
  tx: Queryable,
  notificationsList: CreateNotificationParams<T>[]
): number[] {
  const ids: number[] = [];
  for (const params of notificationsList) {
    const id = writeNotification(tx, params);
    if (id !== null) {
      ids.push(id);
    }
  }
  return ids;
}

export function getUnreadCount(db: Queryable, userId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt)
      )
    )
    .get();

  return result?.count ?? 0;
}

export function listRecentNotifications(
  db: Queryable,
  userId: number,
  limit = 6,
  now: Date = new Date()
): FormattedNotification[] {
  const rows = db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientUserId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .all();

  return rows.map((row) => formatNotification(row, now));
}

export function listPaginatedNotifications(
  db: Queryable,
  userId: number,
  page = 1,
  perPage = 15,
  now: Date = new Date()
): {
  notifications: FormattedNotification[];
  total: number;
  totalPages: number;
  page: number;
  perPage: number;
} {
  const offset = Math.max(0, (page - 1) * perPage);

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(eq(notifications.recipientUserId, userId))
    .get();

  const total = totalResult?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const rows = db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientUserId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(perPage)
    .offset(offset)
    .all();

  return {
    notifications: rows.map((row) => formatNotification(row, now)),
    total,
    totalPages,
    page,
    perPage,
  };
}

export function markAsRead(
  db: Queryable,
  userId: number,
  notificationId: number,
  now: Date = new Date()
): void {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt)
      )
    )
    .run();
}

export function markAllAsRead(
  db: Queryable,
  userId: number,
  now: Date = new Date()
): void {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt)
      )
    )
    .run();
}

export interface PurgeOldNotificationsOptions {
  db?: Queryable;
  now?: Date;
}

export function purgeOldNotifications({
  db: queryDb,
  now = new Date(),
}: PurgeOldNotificationsOptions = {}): number {
  const database = queryDb ?? defaultDb;
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(now.getTime() - NINETY_DAYS_MS).toISOString();

  const pendingNotificationIds = database
    .select({ notificationId: emailOutbox.notificationId })
    .from(emailOutbox)
    .where(eq(emailOutbox.status, OutboxStatus.Pending));

  const deletedRows = database
    .delete(notifications)
    .where(
      and(
        isNotNull(notifications.readAt),
        lt(notifications.readAt, cutoffIso),
        notInArray(notifications.id, pendingNotificationIds)
      )
    )
    .returning({ id: notifications.id })
    .all();

  return deletedRows.length;
}
