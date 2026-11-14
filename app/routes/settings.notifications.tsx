import { useState, useEffect } from "react";
import { Link, useFetcher, data, isRouteErrorResponse } from "react-router";
import { toast } from "sonner";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/settings.notifications";
import { db } from "~/db";
import {
  users,
  teamMembers,
  TeamMemberRole,
  UserRole,
  NotificationType,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import {
  getUserNotificationPreferences,
  updateUserNotificationPreference,
  type UserPreferenceView,
} from "~/lib/notifications.server";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, Bell } from "lucide-react";
import { cn } from "~/lib/utils";
import { parseFormData } from "~/lib/validation";

const updatePreferenceSchema = z.object({
  type: z.nativeEnum(NotificationType, {
    errorMap: () => ({ message: "Invalid notification type" }),
  }),
  emailEnabled: z.preprocess(
    (val) => val === "true" || val === true,
    z.boolean()
  ),
});

export function meta() {
  return [
    { title: "Notification Settings — Cadence" },
    {
      name: "description",
      content: "Manage your email notification preferences",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view notification settings.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser) {
    throw data("User not found.", { status: 404 });
  }

  const roles: (UserRole | "team_admin" | string)[] = [currentUser.role];

  const isTeamAdmin = !!db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, currentUserId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (isTeamAdmin) {
    roles.push("team_admin");
  }

  const preferences = getUserNotificationPreferences(db, currentUserId, roles);

  return {
    user: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      role: currentUser.role,
      isTeamAdmin,
    },
    preferences,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, updatePreferenceSchema);

  if (!parsed.success) {
    throw data(
      { error: parsed.errors.type || "Invalid notification type" },
      { status: 400 }
    );
  }

  updateUserNotificationPreference(
    db,
    currentUserId,
    parsed.data.type,
    parsed.data.emailEnabled
  );

  return {
    success: true,
    type: parsed.data.type,
    emailEnabled: parsed.data.emailEnabled,
  };
}

function PreferenceRow({
  pref,
  onToggle,
}: {
  pref: UserPreferenceView;
  onToggle: (type: NotificationType, nextVal: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
      <div className="space-y-1 pr-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm font-medium",
              pref.mandatory ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {pref.label}
          </span>
          {pref.mandatory && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Always sent
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {pref.mandatory
            ? "Mandatory notifications are always sent to your email and cannot be disabled."
            : "Receive an email when this event occurs."}
        </p>
      </div>

      <div className="shrink-0">
        {pref.mandatory ? (
          <button
            type="button"
            disabled
            role="switch"
            aria-checked="true"
            aria-label={`${pref.label} (always sent)`}
            className="relative inline-flex h-6 w-11 cursor-not-allowed items-center rounded-full bg-primary/40 opacity-60 transition-colors"
          >
            <span className="inline-block size-4 translate-x-6 transform rounded-full bg-background shadow-md transition-transform" />
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={pref.emailEnabled}
            aria-label={`Toggle email for ${pref.label}`}
            onClick={() => onToggle(pref.type, !pref.emailEnabled)}
            className={cn(
              "relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
              pref.emailEnabled ? "bg-primary" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "inline-block size-4 transform rounded-full bg-background shadow-md transition-transform",
                pref.emailEnabled ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        )}
      </div>
    </div>
  );
}

export default function NotificationSettings({
  loaderData,
}: Route.ComponentProps) {
  const { preferences } = loaderData;
  const [localPrefs, setLocalPrefs] = useState<UserPreferenceView[]>(preferences);
  const fetcher = useFetcher<{
    success?: boolean;
    type?: NotificationType;
    emailEnabled?: boolean;
    error?: string;
  }>();

  useEffect(() => {
    setLocalPrefs(preferences);
  }, [preferences]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success("Notification preference updated.");
    } else if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  function handleToggle(type: NotificationType, nextVal: boolean) {
    setLocalPrefs((prev) =>
      prev.map((p) => (p.type === type ? { ...p, emailEnabled: nextVal } : p))
    );

    fetcher.submit(
      { type, emailEnabled: String(nextVal) },
      { method: "post" }
    );
  }

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <Link to="/settings" className="hover:text-foreground">
          Settings
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Notifications</span>
      </nav>

      {/* Settings Navigation Tabs */}
      <div className="mb-6 flex gap-2 border-b border-border pb-3">
        <Link
          to="/settings"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Profile
        </Link>
        <Link
          to="/settings/notifications"
          className="rounded-md bg-muted px-3 py-1.5 text-sm font-medium text-foreground"
        >
          Notifications
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Notification Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Choose which notifications you receive by email. In-app notifications
          are always enabled.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Email Preferences</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Changes apply to future notifications only. Existing emails and
            in-app notifications are not affected.
          </p>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {localPrefs.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No notifications configured for your role.
            </p>
          ) : (
            localPrefs.map((pref) => (
              <PreferenceRow
                key={pref.type}
                pref={pref}
                onToggle={handleToggle}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 404) {
      title = "User not found";
      message =
        typeof error.data === "string" ? error.data : "User not found.";
    } else {
      title = `Error ${error.status}`;
      message =
        typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
