import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { enrollStudent } from "./enrollments.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;
  const addLesson = (title: string, position: number) =>
    db
      .insert(schema.lessons)
      .values({ moduleId, title, position })
      .returning()
      .get().id;
  lessonId = addLesson("Lesson 1", 1);
  otherLessonId = addLesson("Lesson 2", 2);
});

describe("bookmarking a Lesson", () => {
  it("adds a Bookmark, and a second toggle removes it", () => {
    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(true);

    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on a Lesson", () => {
    toggleBookmark(db, base.user.id, lessonId);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId })
        .run()
    ).toThrow();
  });
});

describe("saving a Note", () => {
  it("creates the Note, then replaces its body and moves 'last edited' on", () => {
    saveNote(db, base.user.id, lessonId, "first", NOW);
    saveNote(db, base.user.id, lessonId, "second", LATER);

    expect(getNote(db, base.user.id, lessonId)).toMatchObject({
      body: "second",
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("trims the body", () => {
    saveNote(db, base.user.id, lessonId, "  hello  ", NOW);

    expect(getNote(db, base.user.id, lessonId)?.body).toBe("hello");
  });

  it("refuses a Note over 2,000 characters and accepts exactly 2,000", () => {
    expect(
      saveNote(db, base.user.id, lessonId, "a".repeat(2001), NOW)
    ).toMatchObject({ ok: false });
    expect(getNote(db, base.user.id, lessonId)).toBeUndefined();

    expect(
      saveNote(db, base.user.id, lessonId, "a".repeat(2000), NOW)
    ).toMatchObject({ ok: true });
  });

  it("refuses an empty Note", () => {
    expect(saveNote(db, base.user.id, lessonId, "   ", NOW)).toMatchObject({
      ok: false,
    });
  });
});

describe("the Saved lists", () => {
  it("hold only the Student's own rows, newest first, with Lesson and Course", () => {
    const other = db
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    db.insert(schema.bookmarks)
      .values([
        {
          userId: base.user.id,
          lessonId,
          createdAt: NOW.toISOString(),
        },
        {
          userId: base.user.id,
          lessonId: otherLessonId,
          createdAt: LATER.toISOString(),
        },
        { userId: other.id, lessonId, createdAt: LATER.toISOString() },
      ])
      .run();
    saveNote(db, base.user.id, lessonId, "older", NOW);
    saveNote(db, base.user.id, otherLessonId, "newer", LATER);
    saveNote(db, other.id, lessonId, "not mine", LATER);

    expect(listBookmarks(db, base.user.id)).toMatchObject([
      { lessonId: otherLessonId, lessonTitle: "Lesson 2", courseTitle: "Test Course" },
      { lessonId, lessonTitle: "Lesson 1", courseSlug: "test-course" },
    ]);
    expect(listNotes(db, base.user.id).map((n) => n.body)).toEqual([
      "newer",
      "older",
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    await enrollStudent(
      db,
      base.user.id,
      base.course.id,
      NOW,
      fakeNotifications()
    );
    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "keep me", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "No.",
      NOW,
      fakeNotifications()
    );
    if (!raised.ok) throw new Error(raised.error);
    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      fakeNotifications()
    );

    expect(isBookmarked(db, base.user.id, lessonId)).toBe(true);
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("keep me");
  });
});
