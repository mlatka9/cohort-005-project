import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { db } from "~/db";
import {
  markAsRead,
  markAllAsRead,
} from "~/lib/notifications.server";

const notificationActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("mark-read"),
    notificationId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("mark-all-read"),
  }),
]);

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Unauthorized", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, notificationActionSchema);

  if (!parsed.success) {
    return data({ error: "Invalid action" }, { status: 400 });
  }

  if (parsed.data.intent === "mark-read") {
    markAsRead(db, currentUserId, parsed.data.notificationId);
    return data({ success: true });
  }

  if (parsed.data.intent === "mark-all-read") {
    markAllAsRead(db, currentUserId);
    return data({ success: true });
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}
