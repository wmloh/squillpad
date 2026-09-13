import { useEffect, useState } from "react";

import { accessHeaders, clearAccessToken, validateHostUrl } from "./host-access";

export interface ConnectionScreenProps {
  readonly error?: string;
  readonly authentication?: boolean;
  readonly onRetry?: () => void;
  readonly transientOperation?: boolean;
  readonly theme?: "light" | "dark";
}

interface AuthenticationStatus {
  readonly canRegister: boolean;
  readonly hasAccounts: boolean;
  readonly hostAuthorized: boolean;
  readonly username?: string;
}

interface AccountSummary {
  readonly username: string;
  readonly createdAt: string;
}

/** Lets a browser client reach a host while keeping project data on that host. */
export function ConnectionScreen({
  error,
  authentication = false,
  onRetry,
  transientOperation = false,
  theme = "light",
}: ConnectionScreenProps) {
  const [hostUrl, setHostUrl] = useState("");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [authenticationStatus, setAuthenticationStatus] = useState<AuthenticationStatus>();
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);

  useEffect(() => {
    if (!authentication) return;
    void fetch("/api/auth/status", { headers: accessHeaders(), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load account access");
        const status = (await response.json()) as AuthenticationStatus;
        setAuthenticationStatus(status);
        if (status.hostAuthorized) {
          return fetch("/api/auth/accounts", { headers: accessHeaders(), cache: "no-store" });
        }
        return undefined;
      })
      .then(async (response) => {
        if (response?.ok) {
          const body = (await response.json()) as { accounts: readonly AccountSummary[] };
          setAccounts(body.accounts);
        }
      })
      .catch((reason: unknown) =>
        setMessage(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [authentication]);

  const submitCredentials = async (action: "login" | "register") => {
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/auth/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...accessHeaders() },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      location.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const manageAccount = async (action: "reset-password" | "remove-account", account: string) => {
    if (action === "remove-account" && !confirm(`Remove the account “${account}”?`)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/auth/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...accessHeaders() },
        body: JSON.stringify({
          username: account,
          ...(action === "reset-password" ? { password: newPassword } : {}),
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      if (action === "remove-account")
        setAccounts((current) => current.filter((item) => item.username !== account));
      setNewPassword("");
      setMessage(
        action === "reset-password"
          ? "Password reset; existing sessions were signed out."
          : "Account removed.",
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const validated = await validateHostUrl(hostUrl);
      location.assign(validated.href);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <main className="connection-screen">
      <section className="connection-card" aria-labelledby="connection-title">
        <img
          className="brand-mark"
          src={theme === "dark" ? "./squillpad-dark.png" : "./squillpad-light.png"}
          alt=""
          aria-hidden="true"
        />
        <h1 id="connection-title">
          {authentication
            ? "Sign in to this notebook"
            : transientOperation
              ? "Updating notebook"
              : "Connect to a SquillPad notebook"}
        </h1>
        {authentication ? (
          <>
            <p className="connection-intro">
              Registered collaborators can sign in whenever this host is running. Passwords sent
              over plain HTTP are not encrypted, so use only a trusted local network.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitCredentials("login");
              }}
            >
              <label htmlFor="account-username">Username</label>
              <input
                id="account-username"
                aria-describedby="account-username-requirements"
                autoComplete="username"
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
              />
              <p className="field-fineprint" id="account-username-requirements">
                3–32 characters. Start with a letter or number; use letters, numbers, dots,
                underscores, or hyphens. Usernames are saved in lowercase.
              </p>
              <label htmlFor="account-password">Password</label>
              <input
                id="account-password"
                type="password"
                autoComplete={
                  authenticationStatus?.hostAuthorized ? "new-password" : "current-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
              <button type="submit" disabled={busy || username.length < 3 || password.length === 0}>
                Sign in
              </button>
              {authenticationStatus?.hostAuthorized && authenticationStatus.canRegister && (
                <button
                  type="button"
                  disabled={busy || username.length < 3 || password.length === 0}
                  onClick={() => void submitCredentials("register")}
                >
                  Create profile
                </button>
              )}
              {authenticationStatus?.username !== undefined && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearAccessToken();
                    location.reload();
                  }}
                >
                  Continue as {authenticationStatus.username}
                </button>
              )}
            </form>
            {authenticationStatus?.hostAuthorized && accounts.length > 0 && (
              <section className="account-management" aria-labelledby="accounts-title">
                <h2 id="accounts-title">Manage profiles</h2>
                <label htmlFor="new-account-password">New password for reset</label>
                <input
                  id="new-account-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={busy}
                />
                {accounts.map((account) => (
                  <div key={account.username}>
                    <span>{account.username}</span>
                    <button
                      type="button"
                      disabled={busy || newPassword.length === 0}
                      onClick={() => void manageAccount("reset-password", account.username)}
                    >
                      Reset password
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void manageAccount("remove-account", account.username)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </section>
            )}
          </>
        ) : transientOperation ? (
          <>
            <p className="connection-intro">
              A repository snapshot operation is still updating this notebook. The connection is
              temporary; retry after the update settles.
            </p>
            {error !== undefined && <p className="connection-error">{error}</p>}
            <button type="button" onClick={() => onRetry?.()} disabled={busy}>
              Retry opening notebook
            </button>
          </>
        ) : (
          <>
            <p className="connection-intro">
              Your space for notes, sketches, and ideas. Enter the authorized URL from your notebook
              host to open your workspace.
            </p>
            <p className="connection-guide-link">
              New to SquillPad? <a href="./docs.html">Read the getting-started guide</a>.
            </p>
            {error !== undefined && <p className="connection-error">{error}</p>}
            <form onSubmit={(event) => void connect(event)}>
              <label htmlFor="host-url">Authorized host URL</label>
              <input
                id="host-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="http://192.168.1.20:4173/#access_token=…"
                value={hostUrl}
                onChange={(event) => setHostUrl(event.target.value)}
                disabled={busy}
              />
              <button type="submit" disabled={busy || hostUrl.trim().length === 0}>
                {busy ? "Checking host…" : "Connect"}
              </button>
            </form>
          </>
        )}
        {message !== undefined && (
          <p className="connection-error" role="alert">
            {message}
          </p>
        )}
      </section>
    </main>
  );
}
