import { CircleAlert } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Header } from "../components/Header";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { authClient, updateUsername, useSession } from "../lib/auth-client";
import { cn } from "../lib/utils";
import { AccountPage } from "./AccountPage";
import { RuntimeSettingsPage } from "./RuntimeSettingsPage";
import { SchedulingSettingsPage } from "./SchedulingSettingsPage";

type SettingsUser = {
  name?: string | null;
  username?: string | null;
  usernameConfirmed?: boolean | null;
  image?: string | null;
};

const settingsLinks = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/account", label: "Account" },
  { to: "/settings/scheduling", label: "Scheduling" },
  { to: "/settings/runtime", label: "Runtime" },
];

function ProfileSettingsPage() {
  const { data: session, refetch } = useSession();
  const user = session?.user as SettingsUser | undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? "");
  const [username, setUsername] = useState(user?.username ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const confirmingUsername = searchParams.get("confirm") === "1" && user?.usernameConfirmed === false;

  useEffect(() => {
    setName(user?.name ?? "");
    setUsername(user?.username ?? "");
  }, [user?.name, user?.username]);

  const trimmedName = name.trim();
  const trimmedUsername = username.trim().toLowerCase();
  const nameDirty = trimmedName !== (user?.name ?? "");
  const usernameDirty = trimmedUsername !== (user?.username ?? "");
  const canSave = (nameDirty || usernameDirty || confirmingUsername) && trimmedName.length > 0 && trimmedUsername.length > 0 && !isSaving;
  const fallback = profileInitial(trimmedName || trimmedUsername || "?");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;

    setError(null);
    setIsSaving(true);

    if (usernameDirty || confirmingUsername) {
      const { error: usernameError } = await updateUsername(trimmedUsername);
      if (usernameError) {
        setError(usernameError.message || "Failed to save username");
        toast.error("Failed to save username");
        setIsSaving(false);
        return;
      }
    }

    if (nameDirty) {
      const { error: nameError } = await authClient.updateUser({ name: trimmedName });
      if (nameError) {
        setError(nameError.message || "Failed to save profile");
        toast.error("Failed to save profile");
        setIsSaving(false);
        return;
      }
    }

    setIsSaving(false);
    await refetch();

    if (confirmingUsername) {
      setSearchParams({}, { replace: true });
      navigate("/");
      toast.success("Username confirmed");
    } else {
      toast.success("Profile saved");
    }
  }

  return (
    <main className="min-w-0 flex-1 space-y-6">
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-content-primary">Profile</h1>
        <p className="mt-1 text-sm text-content-secondary">Manage the identity shown across Agent Kanban.</p>
      </div>

      {confirmingUsername && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <p>Your account was created before usernames existed. Confirm your username to continue — email login will be disabled after this.</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <section className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[96px_1fr]">
            <div>
              <Label className="mb-2 text-xs uppercase tracking-[0.06em] text-content-tertiary">Preview</Label>
              <Avatar size="lg" className="size-14">
                {user?.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback className="text-base font-semibold">{fallback}</AvatarFallback>
              </Avatar>
            </div>

            <div className="space-y-4">
              <Field label="Display name" htmlFor="profile-name">
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={trimmedName.length === 0}
                  autoComplete="name"
                />
                {trimmedName.length === 0 && <p className="text-xs text-error">Display name is required.</p>}
              </Field>

              <Field label="Username" htmlFor="profile-username">
                <Input
                  id="profile-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  aria-invalid={trimmedUsername.length > 0 && (trimmedUsername.length < 3 || trimmedUsername.length > 64)}
                  autoComplete="username"
                />
                {trimmedUsername.length > 0 && (trimmedUsername.length < 3 || trimmedUsername.length > 64) && (
                  <p className="text-xs text-error">Username must be 3–64 characters.</p>
                )}
                <p className="text-xs text-content-tertiary">
                  Lowercase letters, digits, dots, underscores and hyphens. Start and end with a letter or digit.
                </p>
              </Field>
            </div>
          </div>
        </section>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={!canSave}>
            {isSaving ? "Saving..." : confirmingUsername ? "Confirm username" : "Save profile"}
          </Button>
          {!confirmingUsername && !nameDirty && !usernameDirty && <p className="text-xs text-content-tertiary">No unsaved changes</p>}
        </div>
      </form>
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-xs uppercase tracking-[0.06em] text-content-tertiary">
        {label}
      </Label>
      {children}
    </div>
  );
}

function profileInitial(value: string) {
  return value.trim().charAt(0).toUpperCase() || "?";
}

export function AccountSettingsPage() {
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8 md:flex-row md:px-8">
        <aside className="w-full shrink-0 md:w-48">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-content-tertiary">Settings</h2>
          <nav aria-label="Settings" className="space-y-1">
            {settingsLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive ? "bg-accent-soft text-accent" : "text-content-secondary hover:bg-surface-secondary hover:text-content-primary",
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <Routes>
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<ProfileSettingsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="scheduling" element={<SchedulingSettingsPage />} />
          <Route path="runtime" element={<RuntimeSettingsPage />} />
          <Route path="*" element={<Navigate to="profile" replace />} />
        </Routes>
      </div>
    </div>
  );
}
