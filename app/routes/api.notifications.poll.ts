import { data } from "react-router";
import type { Route } from "./+types/api.notifications.poll";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  getUnreadCount,
  listRecentNotifications,
} from "~/lib/notifications.server";

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    return data({ unreadCount: 0, recentNotifications: [] });
  }

  const unreadCount = getUnreadCount(db, currentUserId);
  const recentNotifications = listRecentNotifications(db, currentUserId, 6);

  return data({ unreadCount, recentNotifications });
}
