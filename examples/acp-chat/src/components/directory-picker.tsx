import { useEffect, useRef, useState } from "react";
import type { FsDirsResponse } from "../types.js";

type DirState = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
};

/**
 * Working-directory picker styled as a Pase chip that opens an explorer-style
 * popover: current path, parent navigation, and the subdirectory list of the
 * directory the chat server can see.
 */
export function DirectoryPicker({
  value,
  defaultPath,
  disabled,
  onChange,
}: {
  /** Current working directory input ("" = server default). */
  value?: string;
  /** Where browsing starts when nothing was typed yet (server cwd). */
  defaultPath?: string;
  disabled?: boolean;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DirState | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const browse = async (path: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
      const payload = (await response.json()) as FsDirsResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "无法列出目录");
      }
      setState({ path: payload.path, parent: payload.parent, entries: payload.entries });
      setDraft(payload.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void browse(value?.trim() || defaultPath?.trim() || ".");
  };

  // Close the popover on any click outside of it.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const label = value?.trim() ? basename(value.trim()) : "工作目录…";

  return (
    <div className="dir-picker" ref={rootRef}>
      <button
        type="button"
        className="chip chip-as-button"
        disabled={disabled}
        onClick={toggle}
        title={value?.trim() || "选择工作目录"}
        aria-expanded={open}
      >
        <span className="chip-glyph" aria-hidden="true">
          ▸
        </span>
        <span className="chip-label">{label}</span>
        <span className="chip-glyph chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="dir-popover" role="dialog" aria-label="选择工作目录">
          <div className="dir-current">
            <input
              type="text"
              className="mono"
              value={draft}
              placeholder={defaultPath}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim()) {
                  event.preventDefault();
                  void browse(draft.trim());
                }
              }}
              aria-label="目录路径"
            />
          </div>
          {loading ? <p className="muted small dir-note">加载中…</p> : null}
          {error ? <p className="error-inline dir-note">{error}</p> : null}
          {!loading && state ? (
            <>
              {state.parent ? (
                <button
                  type="button"
                  className="dir-row dir-parent"
                  onClick={() => void browse(state.parent as string)}
                >
                  <span className="dir-glyph" aria-hidden="true">
                    ↑
                  </span>
                  <span className="dir-name">{state.parent}</span>
                </button>
              ) : null}
              <div className="dir-list">
                {state.entries.length === 0 ? (
                  <p className="muted small dir-note">没有子目录。</p>
                ) : (
                  state.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="dir-row"
                      onClick={() => void browse(entry.path)}
                      title={entry.path}
                    >
                      <span className="dir-glyph" aria-hidden="true">
                        ▸
                      </span>
                      <span className="dir-name">{entry.name}</span>
                    </button>
                  ))
                )}
              </div>
              <div className="dir-footer">
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => {
                    onChange(state.path);
                    setOpen(false);
                  }}
                >
                  使用此目录
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function basename(path: string): string {
  const withoutSlash = path.replace(/\/+$/, "");
  const index = withoutSlash.lastIndexOf("/");
  return index >= 0 ? withoutSlash.slice(index + 1) : withoutSlash;
}
