import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, CourseStatus } from "~/db/schema";
import {
  notifyOnCourseArchived,
  notifyOnCoursePublished,
} from "~/lib/notifications.server";

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

export interface UpdateCourseStatusOptions {
  now?: Date;
}

export interface UpdateCourseStatusResult {
  course: typeof courses.$inferSelect;
  notificationId: number | null;
}

export function updateCourseStatus(
  db: Queryable,
  courseId: number,
  status: CourseStatus,
  options?: UpdateCourseStatusOptions
): UpdateCourseStatusResult {
  const execute = (tx: Queryable): UpdateCourseStatusResult => {
    const existingCourse = tx
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();

    if (!existingCourse) {
      throw new Error(`Course with id ${courseId} not found`);
    }

    // Double submit / redundant status update: do not generate new updatedAt timestamp
    if (existingCourse.status === status) {
      let notificationId: number | null = null;
      if (status === CourseStatus.Archived) {
        notificationId = notifyOnCourseArchived(tx, existingCourse);
      } else if (status === CourseStatus.Published) {
        notificationId = notifyOnCoursePublished(tx, existingCourse);
      }
      return {
        course: existingCourse,
        notificationId,
      };
    }

    const nowIso = (options?.now ?? new Date()).toISOString();

    const updatedCourse = tx
      .update(courses)
      .set({ status, updatedAt: nowIso })
      .where(eq(courses.id, courseId))
      .returning()
      .get();

    let notificationId: number | null = null;
    if (status === CourseStatus.Archived) {
      notificationId = notifyOnCourseArchived(tx, updatedCourse);
    } else if (status === CourseStatus.Published) {
      notificationId = notifyOnCoursePublished(tx, updatedCourse);
    }

    return {
      course: updatedCourse,
      notificationId,
    };
  };

  if ("transaction" in db && typeof db.transaction === "function") {
    return (db as Db).transaction((tx) => execute(tx));
  }
  return execute(db);
}
