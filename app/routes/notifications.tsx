import { data, Link, useNavigate, useFetcher, useSearchParams } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/notifications";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  getUnreadCount,
  listPaginatedNotifications,
  markAsRead,
  markAllAsRead,
  type FormattedNotification,
} from "~/lib/notifications.server";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Bell, CheckCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";
import { parseFormData } from "~/lib/validation";

const pageSchema = z.coerce.number().int().min(1).catch(1);

const notificationPageActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-read"),
    notificationId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-all-read"),
  }),
]);

export function meta() {
  return [
    { title: "Notifications — Cadence" },
    { name: "description", content: "Your in-app notifications" },
  ];
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Please select a user from the DevUI panel.", { status: 401 });
  }

  const page = pageSchema.parse(url.searchParams.get("page"));
  const perPage = 15;

  const paginated = listPaginatedNotifications(db, currentUserId, page, perPage);
  const unreadCount = getUnreadCount(db, currentUserId);

  return {
    ...paginated,
    unreadCount,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Unauthorized", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, notificationPageActionSchema);

  if (!parsed.success) {
    return data({ error: "Invalid action" }, { status: 400 });
  }

  if (parsed.data.intent === "mark-read") {
    markAsRead(db, currentUserId, parsed.data.notificationId);
    return { success: true };
  }

  if (parsed.data.intent === "mark-all-read") {
    markAllAsRead(db, currentUserId);
    return { success: true };
  }

  return { success: true };
}

export default function NotificationsPage({ loaderData }: Route.ComponentProps) {
  const { notifications, total, totalPages, page, unreadCount } = loaderData;
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [, setSearchParams] = useSearchParams();

  function handleNotificationClick(n: FormattedNotification) {
    if (!n.read) {
      fetcher.submit(
        { intent: "mark-read", notificationId: String(n.id) },
        { method: "post" }
      );
    }
    navigate(n.deepLink || "/dashboard");
  }

  function handleMarkAllRead() {
    fetcher.submit({ intent: "mark-all-read" }, { method: "post" });
  }

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Notifications</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Notifications</h1>
          <p className="mt-1 text-muted-foreground">
            Stay up to date with activity and updates across Cadence.
          </p>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={fetcher.state !== "idle"}
            className="cursor-pointer gap-2"
          >
            <CheckCheck className="size-4" />
            Mark all as read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 rounded-full bg-muted p-4">
              <Bell className="size-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold">You're all caught up</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              When you have new notifications, they'll show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border">
            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleNotificationClick(n)}
                className="flex w-full cursor-pointer items-start gap-4 p-4 text-left transition-colors hover:bg-muted"
              >
                <span
                  className={cn(
                    "mt-1.5 size-2.5 shrink-0 rounded-full",
                    n.read ? "bg-transparent" : "bg-blue-500"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm leading-relaxed",
                      !n.read && "font-semibold"
                    )}
                  >
                    {n.title}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {n.relativeTime} ago
                  </span>
                </div>
              </button>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <div className="text-xs text-muted-foreground">
                Showing page {page} of {totalPages} ({total} total)
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSearchParams(page > 2 ? { page: String(page - 1) } : {})
                  }
                  disabled={page <= 1}
                  className="cursor-pointer"
                >
                  <ChevronLeft className="size-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearchParams({ page: String(page + 1) })}
                  disabled={page >= totalPages}
                  className="cursor-pointer"
                >
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
