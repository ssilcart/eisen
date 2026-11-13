// The editor process on a pseudo-terminal, for the floating editor (S22).
// app.ts feeds its output to an EmbeddedTerminalRenderable and writes the
// keys typed into the box back to it. Bun 1.3.14 ships PTYs as
// `Bun.spawn(cmd, { terminal })`; where it does not (Windows, an older Bun)
// launching throws and app.ts falls back to the full-screen editor (S11).

/** A running editor on a PTY, as app.ts uses it (tests inject a fake one). */
export interface EditorPty {
  /** The editor's output; chunks that arrive before a listener is set are kept for it. */
  onData(listener: (data: Uint8Array) => void): void;
  /** Bytes for the editor: the keys typed into the box, and the box's replies to terminal queries. */
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Resolves with the editor's exit code. */
  readonly exited: Promise<number>;
  /** Ends the editor (the app quits while it is open). */
  kill(): void;
}

/** Starts `cmd` (the editor command) on `path` in a `cols` x `rows` PTY; throws if it cannot. */
export type LaunchEditorPty = (cmd: string[], path: string, cols: number, rows: number) => EditorPty;

/** The terminal the embedded terminal emulates for the editor. */
const TERM = "xterm-256color";

/** The real launcher: `Bun.spawn` with a PTY, in `env` with TERM set for the box. */
export function spawnEditorPty(
  cmd: string[],
  path: string,
  cols: number,
  rows: number,
  env: Record<string, string | undefined> = process.env,
): EditorPty {
  if (typeof Bun.Terminal !== "function") throw new Error("this Bun has no PTY support");
  let listener: ((data: Uint8Array) => void) | null = null;
  const pending: Uint8Array[] = [];
  const proc = Bun.spawn([...cmd, path], {
    env: { ...env, TERM },
    terminal: {
      cols,
      rows,
      name: TERM,
      data(_terminal, data) {
        if (listener) listener(data);
        // Bun may reuse the chunk's buffer: keep a copy until someone listens.
        else pending.push(data.slice());
      },
    },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    // `terminal` ignored (a platform without PTYs): the editor must not run detached.
    proc.kill();
    throw new Error("PTY not supported here");
  }
  const close = () => {
    try {
      if (!terminal.closed) terminal.close();
    } catch {
      // Already gone with the process.
    }
  };
  const exited = proc.exited.then(
    (code) => {
      close();
      return code;
    },
    (error: unknown) => {
      close();
      throw error;
    },
  );
  return {
    onData(next) {
      listener = next;
      for (const chunk of pending.splice(0)) next(chunk);
    },
    write(data) {
      if (!terminal.closed) terminal.write(data);
    },
    resize(c, r) {
      if (!terminal.closed) terminal.resize(c, r);
    },
    exited,
    kill() {
      proc.kill();
      close();
    },
  };
}
