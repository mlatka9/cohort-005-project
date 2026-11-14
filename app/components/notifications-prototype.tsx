// PROTOTYPE (throwaway): three variants of the in-app notification UI, switched with ?variant=A|B|C.
// A = bell in sidebar header + popover, B = top-right bell + slide-over drawer with tabs,
// C = "Inbox" sidebar item + full two-pane inbox page overlay. In-memory mock data only.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Inbox,
  RotateCcw,
  Settings,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";

type N = {
  id: number;
  title: string;
  mandatory: boolean;
  target: string;
  age: string;
  day: string;
  read: boolean;
};

const SEED: N[] = [
  { id: 1, title: 'Your refund for "Advanced TypeScript" was approved', mandatory: true, target: "Course page", age: "5m", day: "Today", read: false },
  { id: 2, title: 'Dana replied to your comment in "Generics deep dive"', mandatory: false, target: "Lesson comment", age: "42m", day: "Today", read: false },
  { id: 3, title: 'Seat claimed on your Team Licence by sam@acme.dev', mandatory: false, target: "Team page", age: "2h", day: "Today", read: false },
  { id: 4, title: 'Purchase confirmed: "React Server Components"', mandatory: true, target: "Welcome page", age: "1d", day: "Yesterday", read: true },
  { id: 5, title: 'Refund request raised for "Intro to SQL"', mandatory: true, target: "/admin/refunds", age: "1d", day: "Yesterday", read: true },
  { id: 6, title: 'Your course "Testing 101" was archived by an admin', mandatory: true, target: "Course page", age: "3d", day: "Earlier", read: true },
  { id: 7, title: 'Your course "Node Streams" was published', mandatory: false, target: "Course page", age: "6d", day: "Earlier", read: true },
];

function useNotifications() {
  const [items, setItems] = useState<N[]>(SEED);
  const [toast, setToast] = useState<string | null>(null);
  const unread = items.filter((i) => !i.read).length;
  return {
    items,
    unread,
    toast,
    open(id: number) {
      const n = items.find((i) => i.id === id)!;
      setItems((s) => s.map((i) => (i.id === id ? { ...i, read: true } : i)));
      setToast(`→ navigates to: ${n.target}`);
      setTimeout(() => setToast(null), 2500);
    },
    markAll: () => setItems((s) => s.map((i) => ({ ...i, read: true }))),
    reset: () => setItems(SEED),
  };
}
type Ctx = ReturnType<typeof useNotifications>;

function Badge({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white", className)}>
      {n > 9 ? "9+" : n}
    </span>
  );
}

function Row({ n, onOpen, compact }: { n: N; onOpen: () => void; compact?: boolean }) {
  return (
    <button
      onClick={onOpen}
      className={cn("flex w-full cursor-pointer items-start gap-3 px-4 text-left hover:bg-muted", compact ? "py-2" : "py-3")}
    >
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-blue-500")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", !n.read && "font-semibold")}>{n.title}</span>
        <span className="text-xs text-muted-foreground">{n.age} ago{n.mandatory ? "" : " · optional"}</span>
      </span>
    </button>
  );
}

function Empty() {
  return <div className="px-4 py-10 text-center text-sm text-muted-foreground">You're all caught up</div>;
}

// Variant A: bell in the sidebar header, popover with latest items
function VariantA({ c }: { c: Ctx }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-notif]")) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <>
      <button
        data-notif
        onClick={() => setOpen((o) => !o)}
        className="fixed left-[168px] top-3 z-40 cursor-pointer rounded-md p-1.5 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        <Badge n={c.unread} className="absolute -right-0.5 -top-0.5" />
      </button>
      {open && (
        <div data-notif className="fixed left-[200px] top-12 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <button title="Notification settings" className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <Settings className="size-4" />
            </button>
          </div>
          <div className="max-h-96 divide-y overflow-y-auto">
            {c.items.length ? c.items.slice(0, 6).map((n) => <Row key={n.id} n={n} compact onOpen={() => { c.open(n.id); setOpen(false); }} />) : <Empty />}
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs">
            <button className="cursor-pointer text-primary hover:underline">View all</button>
            <button onClick={c.markAll} className="cursor-pointer text-primary hover:underline">Mark all as read</button>
          </div>
        </div>
      )}
    </>
  );
}

// Variant B: top-right bell in a slim top strip, right-hand drawer with All/Unread tabs and day groups
function VariantB({ c }: { c: Ctx }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const shown = c.items.filter((i) => tab === "all" || !i.read);
  const days = [...new Set(shown.map((i) => i.day))];
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-5 top-3 z-40 flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-sm hover:bg-muted"
      >
        <Bell className="size-4" />
        {c.unread ? `${c.unread} new` : "Notifications"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="fixed bottom-0 right-0 top-0 z-50 flex w-[420px] flex-col bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-lg font-semibold">Notifications</h2>
              <button onClick={() => setOpen(false)}><X className="size-5" /></button>
            </div>
            <div className="flex items-center justify-between border-b px-5 py-2">
              <div className="flex gap-1">
                {(["all", "unread"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)} className={cn("rounded-full px-3 py-1 text-sm capitalize", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                    {t}{t === "unread" && c.unread ? ` (${c.unread})` : ""}
                  </button>
                ))}
              </div>
              <button onClick={c.markAll} className="text-xs text-primary hover:underline">Mark all as read</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {shown.length === 0 && <Empty />}
              {days.map((d) => (
                <div key={d}>
                  <div className="bg-muted/50 px-5 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>
                  {shown.filter((i) => i.day === d).map((n) => <Row key={n.id} n={n} onOpen={() => { c.open(n.id); setOpen(false); }} />)}
                </div>
              ))}
            </div>
            <div className="border-t px-5 py-3 text-xs text-muted-foreground hover:underline">Notification settings</div>
          </aside>
        </>
      )}
    </>
  );
}

// Variant C: no bell. "Inbox" nav item with badge opens a full two-pane inbox page
function VariantC({ c }: { c: Ctx }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const selected = c.items.find((i) => i.id === sel);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-[130px] left-3 z-40 flex w-[200px] items-center gap-3 rounded-md bg-sidebar px-3 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent"
      >
        <Inbox className="size-4" />
        Inbox
        <Badge n={c.unread} className="ml-auto" />
      </button>
      {open && (
        <div className="fixed bottom-0 left-56 right-0 top-0 z-40 flex bg-background">
          <div className="flex w-[380px] flex-col border-r">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <h2 className="font-semibold">Inbox</h2>
              <button onClick={c.markAll} className="text-xs text-primary hover:underline">Mark all as read</button>
            </div>
            <div className="flex-1 divide-y overflow-y-auto">
              {c.items.map((n) => <Row key={n.id} n={n} onOpen={() => { c.open(n.id); setSel(n.id); }} />)}
            </div>
          </div>
          <div className="relative flex flex-1 items-center justify-center p-10">
            <button onClick={() => setOpen(false)} className="absolute right-4 top-4"><X className="size-5" /></button>
            {selected ? (
              <div className="max-w-md space-y-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{selected.mandatory ? "Always sent" : "Optional"} · {selected.age} ago</div>
                <h3 className="text-xl font-semibold">{selected.title}</h3>
                <div className="inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Go to {selected.target}</div>
                <div className="text-xs text-muted-foreground">Notification settings</div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Select a notification</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const VARIANTS = ["A", "B", "C"] as const;
const NAMES = { A: "Bell + popover", B: "Top pill + drawer", C: "Inbox page" };

export function NotificationsPrototype() {
  const [params, setParams] = useSearchParams();
  const variant = (params.get("variant") ?? "A") as (typeof VARIANTS)[number];
  const c = useNotifications();

  function go(delta: number) {
    const i = VARIANTS.indexOf(variant);
    const next = VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length];
    setParams((p) => { p.set("variant", next); return p; }, { replace: true });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,[contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <>
      {variant === "A" && <VariantA c={c} />}
      {variant === "B" && <VariantB c={c} />}
      {variant === "C" && <VariantC c={c} />}
      {c.toast && (
        <div className="fixed right-5 top-16 z-[60] rounded-md bg-foreground px-3 py-2 text-xs text-background shadow-lg">{c.toast}</div>
      )}
      <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-xl">
        <button className="cursor-pointer" onClick={() => go(-1)}><ChevronLeft className="size-4" /></button>
        <span>{variant} ({NAMES[variant]})</span>
        <button className="cursor-pointer" onClick={() => go(1)}><ChevronRight className="size-4" /></button>
        <button className="cursor-pointer" onClick={c.reset} title="Reset state"><RotateCcw className="size-3.5" /></button>
      </div>
    </>
  );
}
