# eisen

Eisenhower matrix in your terminal.

`eisen` is a terminal UI that sorts your tasks into the four quadrants of the
Eisenhower matrix (Do, Schedule, Delegate, Delete), with an Inbox for tasks you
have not triaged yet and a global search to find any task instantly.

> Status: v0.1 in development.

## Install

Homebrew (macOS, Linux):

```sh
brew install ssilcart/tap/eisen
```

From source (needs [Bun](https://bun.sh) 1.3.14 or newer):

```sh
git clone https://github.com/ssilcart/eisen
cd eisen
bun install
bun src/main.ts
```

## Usage

```sh
eisen                          # open the matrix
eisen add "Call the bank #finance" --q1 --due 2026-12-01
eisen ls [--q1|--q2|--q3|--q4|--inbox] [--search "<query>"] [--json]
eisen import tasks.md          # import a Markdown checklist into the Inbox
eisen export > backup.md       # Markdown backup, readable by `eisen import`
```

Data lives in `$XDG_DATA_HOME/eisen/eisen.db` (default
`~/.local/share/eisen/eisen.db`); set `EISEN_DB` to use another file.

## Keybindings

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `h j k l`, arrows | Move between quadrants and tasks                |
| `1`–`4`        | Move the selected task to that quadrant            |
| `a`            | Add a task in the focused quadrant (`#tags` work)  |
| `e`            | Edit the task in `$EDITOR`                         |
| `x`            | Toggle done                                        |
| `d`            | Delete (asks for confirmation)                     |
| `J` / `K`      | Reorder inside the quadrant                        |
| `/`            | Global search (quadrants, Inbox and done tasks)    |
| `i`            | Triage the Inbox                                   |
| `.`            | Show / hide done tasks                             |
| `?`            | Help                                               |
| `q`            | Quit                                               |

`e` opens `$VISUAL`, else `$EDITOR`, else `vi` (arguments work, e.g.
`EDITOR="code --wait"`) on a Markdown file: `# Title` on the first line,
an optional `due: YYYY-MM-DD` line (leave it empty or remove it to clear the
date), a blank line, then the description. `#tags` in the title or
description become tags. Save and quit to apply; a non-zero exit (`:cq` in
Vim) discards the edit.

### Triage

New and imported tasks land in the Inbox. When it is not empty at start the
status line says `press i to triage`; `i` shows its tasks one card at a time
(title, description, tags, due date):

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `1`–`4`        | Send the task to that quadrant, show the next      |
| `s`            | Skip: the task stays in the Inbox                  |
| `e`            | Edit the task in `$EDITOR`, stay on its card       |
| `d`            | Delete (asks for confirmation)                     |
| `Esc` / `q`    | Back to the matrix (does not quit)                 |

A session visits each task once; when the last card is done you are back in
the matrix with a summary such as `Inbox triaged: 6 sorted, 2 skipped`.

### Search

`/` opens a search input in the status line and filters on every keystroke,
over every task: the four quadrants, the Inbox and done tasks (done ones are
shown dimmed with `✓` even when `.` hides them).

- Accents and case are ignored (`compañía` finds `compania`) and typos are
  tolerated: one for words of 4–7 letters, two for 8 or more (`delvira`
  finds `delivra`). Shorter words only match as written.
- Every word must match the title, the description or a tag (`zoho prod`).
  `#word` matches tags only, by prefix (`#zo` finds `#zoho`).
- Best matches come first: title, then tag, then description; whole words
  before prefixes, before parts of words, before typos; open before done.

The matrix stays on screen: each pane keeps only its matches and shows
`matches/total` in its title, and an **Inbox** strip appears under the grid
with the Inbox matches (`j` from the bottom panes moves into it).

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| typing         | Filters live; no other key acts while you type     |
| `Enter`        | Keep the filter and go back to the usual keys: `x`, `d`, `e`, `1`–`4`, `J`/`K` act on the selected match |
| `Esc`          | Clear the filter and restore the full matrix       |
| `/`            | Edit the kept query again                          |

The filter is applied again after every change, so a match you mark done
stays in view with its `✓`. With no results the status line says
`No matches for "…"`. `i` still triages the whole Inbox, not only the
matches, and returns to the filtered view.

From the shell, `eisen ls --search "<query>"` uses the same search. It
combines with `--q1`..`--q4`/`--inbox` and `--json` (each row then carries its
`score` and `matched` fields), and includes done tasks, marked `✓`:

```sh
eisen ls --search "zoho prod"
eisen ls --search "#rainer" --inbox --json
```

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
