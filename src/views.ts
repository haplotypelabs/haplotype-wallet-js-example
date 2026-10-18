// Server-rendered HTML. No frontend framework and no client-side JavaScript.
// The `data-testid` attributes are stable hooks for automated tests.
import type { GrantedScope } from "./scopes.ts";
import type { Sample } from "./contract.ts";
import type { WalletErrorView } from "./wallet-errors.ts";

export type HomeView =
  | {
      kind: "disconnected";
      /** Consent denied or another OAuth error on the way back. */
      authError?: string;
      /** The refresh token stopped working. */
      reconnectRequired?: boolean;
    }
  | {
      kind: "connected";
      email?: string;
      scopes: GrantedScope[];
      samples?: Sample[];
      /** Set when reading samples failed for a reason other than auth. */
      walletError?: WalletErrorView;
    };

export function renderHome(view: HomeView): string {
  return layout(view.kind === "connected" ? connected(view) : disconnected(view));
}

export function renderError(message: string): string {
  return layout(`<h1>Something went wrong</h1>
    <div class="notice notice-error" role="alert">${esc(message)}</div>
    <p><a href="/">Back to the start</a></p>`);
}

function disconnected(view: Extract<HomeView, { kind: "disconnected" }>): string {
  const notice = view.reconnectRequired
    ? `<div class="notice notice-warning" role="alert" data-testid="reconnect-required">
        <strong>Connect Haplotype Wallet again</strong>
        <p>Haplotype Wallet no longer accepts this app's connection. This happens when you
        disconnect the app in your wallet. Connect again to continue.</p>
      </div>`
    : view.authError
      ? `<div class="notice notice-error" role="alert" data-testid="auth-error">
          <strong>Haplotype Wallet was not connected</strong>
          <p>${esc(view.authError)}</p>
        </div>`
      : "";

  return `<h1>Bring your genetic data</h1>
    <p class="lead">Connect your Haplotype Wallet so this app can see which genotype files
    you have. You choose what to share on the next screen.</p>
    ${notice}
    <a class="connect" href="/connect" data-testid="connect-button">
      <img src="/static/connect-button.svg" alt="Connect Haplotype Wallet" width="244" height="44">
    </a>
    <ol class="steps">
      <li>You sign in to Haplotype Wallet.</li>
      <li>You review what this app asks for and approve it.</li>
      <li>You come back here, and the app shows what you shared.</li>
    </ol>
    <p class="muted">You can disconnect this app in Haplotype Wallet at any time.</p>`;
}

function connected(view: Extract<HomeView, { kind: "connected" }>): string {
  const scopes =
    view.scopes.length > 0
      ? `<ul class="scopes">${view.scopes
          .map(
            (s) => `<li data-testid="granted-scope" data-scope="${esc(s.scope)}">
              <span class="check" aria-hidden="true">&#10003;</span>
              <span>${esc(s.description)} <code>${esc(s.scope)}</code></span>
            </li>`,
          )
          .join("")}</ul>`
      : `<p class="muted">You did not grant this app any wallet permissions.</p>`;

  let samples: string;
  if (view.walletError) {
    samples = walletError(view.walletError);
  } else if (!view.samples || view.samples.length === 0) {
    samples = `<div class="empty" data-testid="samples-empty">
      <strong>No samples yet</strong>
      <p>Upload a genotype file to Haplotype Wallet and it will show up here.</p>
    </div>`;
  } else {
    samples = `<table>
      <thead><tr><th>Sample</th><th>Original file</th><th>Processed</th></tr></thead>
      <tbody>${view.samples
        .map(
          (s) => `<tr data-testid="sample-row">
            <td>${esc(s.label)}</td>
            <td class="filename">${esc(s.source_filename)}</td>
            <td><time datetime="${esc(s.processed_at)}">${esc(formatDate(s.processed_at))}</time></td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`;
  }

  return `<p class="status"><span class="dot" aria-hidden="true"></span>Connected</p>
    <h1>Haplotype Wallet is connected</h1>
    ${view.email ? `<p class="lead">Signed in as <strong>${esc(view.email)}</strong></p>` : ""}
    <section>
      <h2>Permissions you granted</h2>
      ${scopes}
    </section>
    <section>
      <h2>Your samples</h2>
      ${samples}
    </section>
    <form class="disconnect" method="post" action="/disconnect">
      <button type="submit" data-testid="disconnect-button">Disconnect</button>
      <p class="muted">Disconnect makes this app forget the connection. To revoke its access,
      disconnect the app in Haplotype Wallet.</p>
    </form>`;
}

/** A failed tool call. `data-code` is the wallet's error code. */
function walletError(error: WalletErrorView): string {
  let body: string;
  switch (error.kind) {
    case "billing":
      body = `<strong>Renew your Haplotype Wallet plan</strong>
        <p>${esc(error.message)}</p>
        ${
          error.renewUrl
            ? `<p><a href="${esc(error.renewUrl)}" data-testid="renew-plan">Manage your plan in Haplotype Wallet</a></p>`
            : ""
        }`;
      break;
    case "missing-scope":
      body = `<strong>This app needs one more permission</strong>
        <p>To show this, the app needs you to allow: ${esc(error.description)}
        <code>${esc(error.scope)}</code>.</p>
        <p><a href="${esc(error.reconnectUrl)}" data-testid="reconnect-scope" data-scope="${esc(error.scope)}">Connect again and allow it</a></p>`;
      break;
    case "retry":
      body = `<strong>Haplotype Wallet did not answer</strong>
        <p>Try again in a moment.</p>
        <p><a href="/" data-testid="retry">Try again</a></p>`;
      break;
    case "other":
      body = `<strong>Haplotype Wallet returned an error</strong>
        <p>${esc(error.message)}</p>
        ${
          error.ref
            ? `<p class="muted">Reference: <code data-testid="error-ref">${esc(error.ref)}</code>. Quote it if you contact Haplotype Labs.</p>`
            : ""
        }`;
      break;
  }
  return `<div class="notice notice-error" role="alert" data-testid="wallet-error" data-code="${esc(error.code)}">
      ${body}
    </div>`;
}

function layout(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example App · Connect Haplotype Wallet</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header>
    <div class="brand"><span class="logo" aria-hidden="true">E</span>Example App</div>
    <span class="tag">Haplotype Wallet integration example</span>
  </header>
  <main>${body}</main>
  <footer>
    Your tokens stay on this app's server. The browser only holds a session cookie.
    <a href="https://www.haplotype.ai/developers/">Haplotype Wallet developer docs</a>
  </footer>
</body>
</html>`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
