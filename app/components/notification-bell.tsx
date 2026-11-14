import { useState, useEffect } from "react";
import { Link, useNavigate, useFetcher } from "react-router";
import { Bell, Settings } from "lucide-react";
import { cn } from "~/lib/utils";
import type { FormattedNotification } from "~/lib/notifications.server";

interface NotificationBellProps {
  initialUnreadCount: number;
  initialRecentNotifications: FormattedNotification[];
}

export function NotificationBell({
  initialUnreadCount,
  initialRecentNotifications,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [items, setItems] = useState<FormattedNotification[]>(
    initialRecentNotifications
  );

  const navigate = useNavigate();
  const pollFetcher = useFetcher<{
    unreadCount: number;
    recentNotifications: FormattedNotification[];
  }>();
  const actionFetcher = useFetcher();

  // Sync state if initial props change (e.g. layout revalidation on route change)
  useEffect(() => {
    setUnreadCount(initialUnreadCount);
  }, [initialUnreadCount]);

  useEffect(() => {
    setItems(initialRecentNotifications);
  }, [initialRecentNotifications]);

  // Polling every ~60 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        pollFetcher.load("/api/notifications/poll");
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [pollFetcher]);

  // Handle poll response
  useEffect(() => {
    if (pollFetcher.data) {
      setUnreadCount(pollFetcher.data.unreadCount);
      setItems(pollFetcher.data.recentNotifications);
    }
  }, [pollFetcher.data]);

  // Non-blocking outside click
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-notif]")) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function handleNotificationClick(n: FormattedNotification) {
    if (!n.read) {
      actionFetcher.submit(
        { intent: "mark-read", notificationId: String(n.id) },
        { method: "post", action: "/api/notifications" }
      );
      setItems((prev) =>
        prev.map((item) => (item.id === n.id ? { ...item, read: true } : item))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setOpen(false);
    navigate(n.deepLink || "/dashboard");
  }

  function handleMarkAllRead() {
    actionFetcher.submit(
      { intent: "mark-all-read" },
      { method: "post", action: "/api/notifications" }
    );
    setItems((prev) => prev.map((item) => ({ ...item, read: true })));
    setUnreadCount(0);
  }

  return (
    <div className="relative inline-block" data-notif>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative cursor-pointer rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="size-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          data-notif
          className="absolute left-full top-0 ml-2 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl"
        >
          {/* Popover Header */}
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <Link
              to="/settings/notifications"
              onClick={() => setOpen(false)}
              title="Notification settings"
              className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Settings className="size-4" />
            </Link>
          </div>

          {/* Popover Body */}
          <div className="max-h-96 divide-y overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                You're all caught up
              </div>
            ) : (
              items.slice(0, 6).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleNotificationClick(n)}
                  className="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      n.read ? "bg-transparent" : "bg-blue-500"
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-sm leading-snug",
                        !n.read && "font-semibold"
                      )}
                    >
                      {n.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {n.relativeTime} ago
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Popover Footer */}
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="cursor-pointer font-medium text-primary hover:underline"
            >
              View all
            </Link>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="cursor-pointer font-medium text-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
