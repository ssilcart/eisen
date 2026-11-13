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

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
