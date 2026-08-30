import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type BootstrapStatus,
  bootstrapRegister,
  getBootstrapStatus,
  isLegacyEmailInput,
  setAuthToken,
  signIn,
  signInLegacyEmail,
} from "../lib/auth-client";

type AuthMode = "bootstrap" | "signin";

export function AuthPage() {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getBootstrapStatus().then((next) => {
      if (next) {
        setStatus(next);
        if (next.registrationOpen) setMode("bootstrap");
      } else {
        setNotice("Could not reach the auth service. Please try again.");
      }
    });
  }, []);

  const onSuccess = (ctx: any) => {
    const token = ctx.response.headers.get("set-auth-token");
    if (token) setAuthToken(token);
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    if (mode === "bootstrap") {
      const { error: registerError } = await bootstrapRegister({ username: identifier, name, password });
      if (registerError) {
        setError(registerError.message || "Registration failed");
        setLoading(false);
        return;
      }
      setLoading(false);
      navigate("/");
      return;
    }

    if (isLegacyEmailInput(identifier)) {
      // Legacy (unconfirmed) accounts can still sign in with their email once.
      const { error: signInError } = await signInLegacyEmail({ email: identifier, password });
      if (signInError) {
        setError(signInError.message || "Sign in failed");
        setLoading(false);
        return;
      }
      setLoading(false);
      navigate("/");
      return;
    }

    const { error: signInError } = await signIn.username({ username: identifier, password, callbackURL: "/" }, { onSuccess });
    if (signInError) {
      setError(signInError.message || "Sign in failed");
      setLoading(false);
      return;
    }
    setLoading(false);
    navigate("/");
  }

  if (status === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface-primary">
        <div className="w-full max-w-sm p-8 space-y-6 text-center">
          <h1 className="text-xl font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </h1>
          <p className="text-sm text-content-secondary">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-primary">
      <div className="w-full max-w-sm p-8 space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </h1>
          <p className="mt-2 text-sm text-content-secondary">{mode === "bootstrap" ? "Create the owner account" : "Sign in to your account"}</p>
        </div>

        <AuthForm
          mode={mode}
          identifier={identifier}
          password={password}
          name={name}
          error={error}
          notice={notice}
          loading={loading}
          legacyEmailEnabled={status.legacyEmailLoginEnabled}
          onIdentifierChange={setIdentifier}
          onPasswordChange={setPassword}
          onNameChange={setName}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}

function AuthForm(props: {
  mode: AuthMode;
  identifier: string;
  password: string;
  name: string;
  error: string | null;
  notice: string | null;
  loading: boolean;
  legacyEmailEnabled: boolean;
  onIdentifierChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const identifierPlaceholder = props.mode === "bootstrap" ? "Username" : props.legacyEmailEnabled ? "Username or legacy email" : "Username";

  return (
    <form onSubmit={props.onSubmit} className="space-y-4">
      {props.mode === "bootstrap" && (
        <input
          type="text"
          placeholder="Display name"
          value={props.name}
          onChange={(e) => props.onNameChange(e.target.value)}
          required
          autoComplete="name"
          className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm text-content-primary outline-none focus:border-accent transition-colors"
        />
      )}
      <input
        type="text"
        placeholder={identifierPlaceholder}
        value={props.identifier}
        onChange={(e) => props.onIdentifierChange(e.target.value)}
        required
        autoComplete={props.mode === "bootstrap" ? "username" : "username"}
        className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm text-content-primary outline-none focus:border-accent transition-colors"
      />
      <input
        type="password"
        placeholder="Password"
        value={props.password}
        onChange={(e) => props.onPasswordChange(e.target.value)}
        required
        minLength={8}
        autoComplete="current-password"
        className="w-full bg-surface-secondary border border-border rounded-lg px-3 py-2 text-sm text-content-primary outline-none focus:border-accent transition-colors"
      />

      {props.error && <p className="text-sm text-error">{props.error}</p>}
      {props.notice && <p className="text-sm text-content-secondary">{props.notice}</p>}

      <button
        type="submit"
        disabled={props.loading}
        className="w-full bg-accent text-surface-primary font-semibold text-sm py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {props.loading ? "..." : props.mode === "bootstrap" ? "Create owner account" : "Sign In"}
      </button>
    </form>
  );
}
