# eisen

Eisenhower matrix in your terminal.

`eisen` is a terminal UI that sorts your tasks into the four quadrants of the
Eisenhower matrix (Do, Schedule, Delegate, Delete, or the names of another
preset), with an Inbox for tasks you have not triaged yet and a global search
to find any task instantly.

> Status: v0.1 in development.

## Install

Homebrew (macOS, Linux):

```sh
brew install ssilcart/tap/eisen
```

Prebuilt binaries (macOS on Apple silicon, Linux x86-64) are attached to each
[GitHub release](https://github.com/ssilcart/eisen/releases), with a
`SHA256SUMS` file. They are not signed with an Apple Developer ID: if macOS
refuses a binary downloaded with a browser, run
`xattr -d com.apple.quarantine eisen` (Homebrew does not need this).

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

## Quadrant names and settings

The quadrants keep their meaning (Q1 important and urgent, Q2 important, Q3
urgent, Q4 neither); a preset only changes their names:

| Preset              | Q1                     | Q2                         | Q3                       | Q4                          |
| ------------------- | ---------------------- | -------------------------- | ------------------------ | --------------------------- |
| `classic` (default) | ✅ Do                  | 📅 Schedule                | 🤝 Delegate              | 🧹 Delete                   |
| `priority`          | 🔴 Urgent & Important  | 🟠 Not Urgent & Important  | 🔵 Urgent & Unimportant  | 🟢 Not Urgent & Unimportant |
| `focus`             | 🔥 Urgent              | ⭐ Important               | ⚡ Needs attention        | 🧊 Someday                  |

The Inbox is `📥 Inbox` in every preset. Each quadrant has its colour (Q1 red,
Q2 amber, Q3 blue, Q4 green, the Inbox grey): the focused pane draws its
border and title in it and highlights its selected task with it.

Press `,` in the matrix to pick a preset (`j`/`k` choose, `Enter` saves,
`Esc` cancels). It is saved in `$EISEN_CONFIG`, else
`$XDG_CONFIG_HOME/eisen/config.json`, else `~/.config/eisen/config.json`:

```json
{ "preset": "focus" }
```

`eisen ls` and `eisen export` use the same names. Exports keep the
`# Q1 · …` headings, and `eisen import` reads only the `Q1`–`Q4` part, so a
backup written with one preset imports into the same quadrants with any other.
A config file that cannot be read or names an unknown preset is ignored with
a warning (the status line in the matrix, stderr in the CLI).

## Layout

The four quadrants fill a 2×2 grid (Q1 top left, Q2 top right, Q3 bottom
left, Q4 bottom right), each titled with its name and open-task count. Under
the grid the **Inbox strip**, titled `📥 Inbox (n)`, lists the tasks you have
not sorted yet. It is always there and takes about a quarter of the screen
(3 to 8 rows, scrolling when the Inbox is longer); on a very small terminal
it shrinks to its title line before the grid gives up any rows. The status
line at the bottom shows the key hints and messages.

The strip is a fifth pane: `j` at the bottom of Q3 or Q4 moves into it, `k`
at its top goes back to the quadrant you came from, and `h`/`l` do nothing
there. Every key below works on its selected task: `1`–`4` sort it into a
quadrant (it leaves the strip and the count drops), `x`, `d`, `e`, `J`/`K`
(order inside the Inbox), and `a` adds a new task to the Inbox.

## Keybindings

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `h j k l`, arrows | Move between quadrants, the Inbox strip and tasks |
| `1`–`4`        | Move the selected task to that quadrant            |
| `a`            | Add a task in the focused quadrant, or to the Inbox from its strip (`#tags` work) |
| `e`            | Edit the task in `$EDITOR`                         |
| `x`            | Toggle done                                        |
| `d`            | Delete (asks for confirmation)                     |
| `J` / `K`      | Reorder inside the quadrant or the Inbox           |
| `/`            | Global search (quadrants, Inbox and done tasks)    |
| `i`            | Triage the Inbox                                   |
| `.`            | Show / hide done tasks                             |
| `,`            | Settings: pick the quadrant names (preset)         |
| `?`            | Help                                               |
| `q`            | Quit                                               |

`e` opens `$VISUAL`, else `$EDITOR`, else `vi` (arguments work, e.g.
`EDITOR="code --wait"`) on a Markdown file: `# Title` on the first line,
an optional `due: YYYY-MM-DD` line (leave it empty or remove it to clear the
date), a blank line, then the description. `#tags` in the title or
description become tags. Save and quit to apply; a non-zero exit (`:cq` in
Vim) discards the edit.

### Triage

New and imported tasks land in the Inbox. You can sort them straight from
the Inbox strip, or triage them: when the Inbox is not empty at start the
status line says `press i to triage`; `i` shows its tasks one card at a time
(title, description, tags, due date), over the grid and the strip:

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
`matches/total` in its title, and so does the Inbox strip, which lists only
the Inbox matches. `Esc` brings back the full lists; the focus stays where it
was, the strip included.

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
bun run build        # standalone binary for this machine in dist/eisen
```

## Release

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`: it checks that
the tag matches `package.json`, runs the type check and the tests, compiles
`eisen` for `darwin-arm64` and `linux-x64` with `bun build --compile`,
smoke-tests both binaries (`scripts/smoke-binary.sh`: `--version`, `add`,
`ls`, and the TUI opened in a pseudo-terminal and quit), and publishes a GitHub
release with `eisen-X.Y.Z-<platform>.tar.gz`, `SHA256SUMS` and the rendered
Homebrew formula `eisen.rb`.

1. Set `"version": "X.Y.Z"` in `package.json` and commit it.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. A tag such as
   `v0.2.0-rc.1` (with the same version in `package.json`) makes a
   pre-release, useful to test the workflow.
3. When the release is out, copy its `eisen.rb` asset to `Formula/eisen.rb`
   in [`ssilcart/homebrew-tap`](https://github.com/ssilcart/homebrew-tap) and
   push it; `brew install ssilcart/tap/eisen` then installs the new version.

The formula comes from `packaging/homebrew/eisen.rb.tmpl`; to render it by
hand from a release's checksums:

```sh
bun scripts/render-formula.ts --version X.Y.Z --sums SHA256SUMS > eisen.rb
```

The compiled binary embeds OpenTUI's native library for its platform. To
cross-compile on one machine, first install every platform's package with
`bun install --os='*' --cpu='*'`, then
`bun build --compile --target=bun-linux-x64 src/main.ts --outfile dist/eisen-linux-x64`.

## License

MIT
