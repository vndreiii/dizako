import { Component, type ErrorInfo, type ReactNode } from "react";
import { diagnostics, describeThrown } from "../errors";

interface State {
  error: Error | null;
  info: string;
  copied: boolean;
}

/**
 * Last line of defence for a render-time throw.
 *
 * Without a boundary React unmounts the whole tree and leaves a blank window
 * with the reason only in a console the user is not looking at. The fallback
 * here is intentionally self-contained - plain DOM, inline-safe class names,
 * no context, no i18n lookup - because anything it depends on could be the
 * thing that just crashed.
 *
 * The two offered exits are the two that actually work: reload the view, or
 * clear the persisted session and reload, which recovers from a stored
 * settings object that the current build cannot render.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: "", copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[dizako] render crashed", error, info.componentStack);
    this.setState({ info: info.componentStack ?? "" });
  }

  private report(): string {
    const { error, info } = this.state;
    return [describeThrown(error), info && `--- component stack ---${info}`, `--- diagnostics ---\n${diagnostics()}`]
      .filter(Boolean)
      .join("\n\n");
  }

  private copy = () => {
    void navigator.clipboard?.writeText(this.report()).then(
      () => this.setState({ copied: true }),
      () => {},
    );
  };

  private reload = () => window.location.reload();

  private resetAndReload = () => {
    try {
      // Only Dizako's own keys: wiping all of localStorage would take the
      // locale and update choices with it for no benefit.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("dizako-")) localStorage.removeItem(key);
      }
    } catch {
      // Storage may be unavailable entirely; reloading is still worth trying.
    }
    window.location.reload();
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <h1 className="crash__title">Dizako hit an unexpected error</h1>
          <p className="crash__body">
            The interface stopped rendering. Nothing you had open was written to disk, so reloading is safe. If it
            keeps happening, clearing the saved session usually fixes a bad stored setting.
          </p>
          <pre className="crash__pre">{describeThrown(error).split("\n").slice(0, 12).join("\n")}</pre>
          <div className="crash__actions">
            <button type="button" className="m3-btn m3-btn--text m3-btn--round" onClick={this.copy}>
              <span className="m3-btn__label">{copied ? "Copied" : "Copy diagnostics"}</span>
            </button>
            <button type="button" className="m3-btn m3-btn--outlined m3-btn--round" onClick={this.resetAndReload}>
              <span className="m3-btn__label">Clear session &amp; reload</span>
            </button>
            <button type="button" className="m3-btn m3-btn--filled m3-btn--round" onClick={this.reload}>
              <span className="m3-btn__label">Reload</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}
