# eisen

Eisenhower matrix in your terminal.

`eisen` is a terminal UI that sorts your tasks into the four quadrants of the
Eisenhower matrix (Do, Schedule, Delegate, Delete, or the names of another
preset), with an Inbox for tasks you have not triaged yet, a global search
to find any task instantly, and a sidebar with a preview of the selected task
and your completed tasks. Keys, editor and panels are configurable.

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

Pick a preset in [Settings](#settings) (`,`, section General) or set
`"preset"` in the [configuration file](#configuration-file).
`eisen ls` and `eisen export` use the same names. Exports keep the
`# Q1 · …` headings, and `eisen import` reads only the `Q1`–`Q4` part, so a
backup written with one preset imports into the same quadrants with any other.
An unknown preset falls back to `classic` with a warning (the status line in
the matrix, stderr in the CLI).

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

Each task row starts with a mark: a bullet `•` in the pane's colour for an
open task, `!` for one whose due date made it urgent, `✓` for a done one.
`:bullets off` (or Settings › General › Bullets) leaves open rows without the
bullet; `!` and `✓` stay.

### Sidebar

On the right, a sidebar holds two panels, stacked: the **preview** on top and
the **done panel** below. It takes 35% of the width (32 to 60 columns); the
grid and the Inbox strip share the rest. With both panels on, the preview
gets about 60% of the height and the done panel the rest; when there is no
room for 5 rows each, the done panel shrinks to its title line.

The sidebar needs at least 100 columns. On a narrower terminal it is hidden:
the status line says `Sidebar hidden: needs 100 columns`, the focus leaves the
done panel for the pane it came from, and the sidebar comes back when the
terminal is wide enough again. The toggles keep working and are still saved.

**Preview** (`p` or `:preview`, on by default). It follows the selection, in
the quadrants, the Inbox strip, the done panel and search results, and shows
the selected task: its title, its quadrant (or `📥 Inbox`, or
`✓ Done · {date}`) in its colour, `due: YYYY-MM-DD` (with `!` when the date
made it urgent), its `#tags`, the description as plain text, and
`created … · updated …` at the bottom. It refreshes after `e`, `x` and
`1`–`4`, and says `No task selected` on an empty pane. It never takes the
focus: `ctrl+d` / `ctrl+u` scroll a long description by half a panel, and
every new selection starts again at the top.

**Done panel** (`.` or `:done`, off by default). Titled `✓ Done (n)`, it lists
every completed task, most recently completed first, each with a `✓` in its
quadrant's colour (grey for the Inbox) and its completion date (`MM-DD`) when
there is room. Done tasks are only listed here: the quadrants and the Inbox
strip show open tasks. `l` from Q2 or Q4 moves into the panel, `h` goes back
to the quadrant you came from, and `j`/`k` move inside it. On its selected
task:

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `x`            | Reopen it: back to its quadrant or the Inbox       |
| `e`            | Edit it                                            |
| `d`            | Delete it (asks for confirmation)                  |
| `1`–`4`        | Move it to that quadrant (it stays done)           |
| `a` / `A`      | New task / quick add in the quadrant beside the panel (Q2 or Q4) |

`J`/`K` do not reorder here: `Done tasks are ordered by completion`.

## Keybindings

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `h j k l`, arrows | Move between quadrants, the Inbox strip, the done panel and tasks |
| `1`–`4`        | Move the selected task to that quadrant            |
| `a`            | New task in the editor, in the focused quadrant or the Inbox from its strip |
| `A`            | Quick add: type a title in the status line (`#tags` work) |
| `e`            | Edit the task in the editor                        |
| `x`            | Toggle done                                        |
| `d`            | Delete (asks for confirmation)                     |
| `J` / `K`      | Reorder inside the quadrant or the Inbox           |
| `/`            | Global search (quadrants, Inbox and done tasks)    |
| `i`            | Triage the Inbox                                   |
| `.`            | Show / hide the done panel (`l` from Q2/Q4 enters it, `h` leaves) |
| `p`            | Show / hide the preview of the selected task       |
| `ctrl+d` / `ctrl+u` | Scroll the preview down / up                  |
| `:`            | Command line (see below)                           |
| `,`            | Settings: quadrant names, panels, editor, keys     |
| `?`            | Help                                               |
| `q`            | Quit                                               |

These are the default keys; every one of them can be changed (see
[Rebindable keys](#rebindable-keys)), and the help (`?`) and the status line
always show the keys in use. `Esc`, `Enter`, `Backspace` and `Ctrl+C` are
fixed.

### Editing tasks

`a`, `e` and `e` on a triage card open the editor chosen in Settings › Editor
(`editor.mode` in the configuration file):

- **`auto`** (default): `$VISUAL`, else `$EDITOR`, else `vi` (arguments work,
  e.g. `EDITOR="code --wait"`).
- **`command`**: the command in `editor.command`, e.g. `nvim`, `vim`, `nano`,
  `hx` or any command line (split on spaces). An empty one falls back to
  `auto`.
- **`form`**: a form inside eisen, no external editor.

`auto` and `command` open the program in a floating box over the matrix
(`editor.display` `floating`, the default), titled `New task · {quadrant}` or
`Edit · {title}` in the quadrant's colour. While it is open every key goes to
the editor (`q` and `Ctrl+C` included), and the box follows terminal resizes.
The editor works on a Markdown file: `# Title` on the first line, an optional
`due: YYYY-MM-DD` line (leave it empty or remove it to clear the date), a
blank line, then the description. `#tags` in the title or description become
tags. Save and quit to apply; a non-zero exit (`:cq` in Vim) discards it, and
a new task with an empty title is cancelled.

The editor takes the whole terminal instead with `editor.display`
`fullscreen`, when the terminal is smaller than 40×12, when a
pseudo-terminal cannot be started, or when `EISEN_EDITOR_MODE=fullscreen` is
set (the environment variable wins over the setting).

The **form** opens in the same floating box, with the same title, and has
three fields: Title (one line), Due (`YYYY-MM-DD`; empty clears the date) and
Description (several lines). `#tags` in the title or description become tags,
as in the file. Every key goes to the form while it is open.

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `Tab` / `Shift+Tab` | Next / previous field                         |
| `Enter`        | Next field in Title and Due; a new line in Description |
| `Ctrl+S`       | Save                                               |
| `Esc`          | Cancel; with changes, a second `Esc` confirms (`Discard changes? Esc again`) |

The form's last line shows these keys. An invalid due date or an empty title
on an existing task shows an error there instead and nothing is saved; a new task with an empty title is cancelled.
On a terminal smaller than 40×12 the form fills the screen above the status
line. `A` and `:add` stay one-line quick adds in every mode.

### Triage

New and imported tasks land in the Inbox. You can sort them straight from
the Inbox strip, or triage them: when the Inbox is not empty at start the
status line says `press i to triage`; `i` shows its tasks one card at a time
(title, description, tags, due date), over the grid and the strip:

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `1`–`4`        | Send the task to that quadrant, show the next      |
| `s`            | Skip: the task stays in the Inbox                  |
| `e`            | Edit the task in the editor, stay on its card      |
| `d`            | Delete (asks for confirmation)                     |
| `?`            | Help                                               |
| `Esc` / `q`    | Back to the matrix (does not quit)                 |

A session visits each task once; when the last card is done you are back in
the matrix with a summary such as `Inbox triaged: 6 sorted, 2 skipped`.

### Search

`/` opens a search input in the status line and filters on every keystroke,
over every task: the four quadrants, the Inbox and done tasks. When the done
panel is on screen, done matches are listed there (with `matches/total` in
its title) and the quadrants keep only open matches; when it is off or the
sidebar is hidden, done matches show in their quadrant, dimmed with `✓`.

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
stays in view: in the done panel when it is on screen, else in its quadrant
with its `✓`. With no results the status line says
`No matches for "…"`. `i` still triages the whole Inbox, not only the
matches, and returns to the filtered view.

From the shell, `eisen ls --search "<query>"` uses the same search. It
combines with `--q1`..`--q4`/`--inbox` and `--json` (each row then carries its
`score` and `matched` fields), and includes done tasks, marked `✓`:

```sh
eisen ls --search "zoho prod"
eisen ls --search "#rainer" --inbox --json
```

## Command line

`:` opens a command line in the status line, like `/`. No other key acts
while you type.

| Command                  | Effect                                      |
| ------------------------ | ------------------------------------------- |
| `:preview [on\|off]`     | Show / hide the preview panel               |
| `:done [on\|off]`        | Show / hide the done panel                  |
| `:bullets [on\|off]`     | Show / hide the bullets before open tasks   |
| `:search <query>`        | Search, like `/` then `Enter`               |
| `:add <title>`           | Quick add in the focused quadrant, or the Inbox from its strip (`#tags` work) |
| `:triage`                | Triage the Inbox                            |
| `:settings`              | Open Settings                               |
| `:help`                  | Open the help                               |
| `:quit`, `:q`            | Quit                                        |

Without an argument `:preview`, `:done` and `:bullets` flip the panel or the
bullets; `on`/`off` set it (asking for the current value only says so).
Every change is saved to the configuration file at once; if the file cannot
be written the status line says why and the change lasts for the session.
Command names are exact and case-sensitive. An unknown command or a wrong
argument changes nothing and says `Unknown command: foo` or
`Usage: :preview [on|off]`.

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `Tab`          | Complete the command name, then `on`/`off`; press again to cycle through the choices |
| `↑` / `↓`      | Older / newer commands of this session             |
| `Enter`        | Run                                                |
| `Esc`          | Cancel (`Backspace` on an empty line too)          |

## Settings

`,` (or `:settings`) opens Settings over the matrix, with three sections as
tabs on its first row. Every change applies at once and is saved to the
[configuration file](#configuration-file); if the file cannot be written the
status line says why and the change lasts for the session.

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `Tab` / `Shift+Tab` | Next / previous section                       |
| `j` / `k`, arrows | Move                                            |
| `Enter` / `Space` | Change the value under the cursor and save it   |
| `Esc`          | Close                                              |

- **General**: the quadrant names (each preset with a preview of its four
  names; `Enter` applies and saves it and Settings stays open), then
  **Preview**, **Done panel** and **Bullets**, on or off.
- **Editor**: the mode (`auto`, `command` or `form`, see
  [Editing tasks](#editing-tasks)); for `command`, the command (`nvim`, `vim`,
  `nano`, `hx` or `Custom…`, which opens a one-line input: `Enter` saves,
  `Esc` cancels); for `auto` and `command`, the display (`floating` or
  `fullscreen`).
- **Keys**: one row per action, grouped Matrix and Triage, with its current
  keys; a `*` marks the ones changed from the defaults.

| Key in Keys    | Action                                             |
| -------------- | -------------------------------------------------- |
| `Enter`        | `Press a key for {action} (Esc cancels)`: the key you press replaces the action's keys |
| `a`            | Same, but the key is added to the action's keys    |
| `Backspace`    | Remove the action's last key                       |
| `r`            | Reset the action to its default keys               |
| `R`            | Reset every key, after a `y/n`                     |

A key that cannot be bound, or that another action already holds, is refused
with a message such as `` `x` is already Toggle done ``.

## Configuration file

Settings live in `$EISEN_CONFIG`, else `$XDG_CONFIG_HOME/eisen/config.json`,
else `~/.config/eisen/config.json`. Every field is optional; this is the full
file with the default values and two key overrides:

```json
{
  "preset": "classic",
  "view": { "preview": true, "donePanel": false, "bullets": true },
  "editor": { "mode": "auto", "command": "nvim", "display": "floating" },
  "keys": { "toggle_done": ["space"], "triage.skip": ["n"] }
}
```

| Field              | Values                                          |
| ------------------ | ----------------------------------------------- |
| `preset`           | `classic`, `priority` or `focus`                |
| `view.preview`     | `true` / `false`: the preview panel             |
| `view.donePanel`   | `true` / `false`: the done panel                |
| `view.bullets`     | `true` / `false`: `•` before open tasks         |
| `editor.mode`      | `auto`, `command` or `form`                     |
| `editor.command`   | the program for `command` mode, with its arguments |
| `editor.display`   | `floating` or `fullscreen` (`auto` and `command` only) |
| `keys`             | overrides of the default keys, see [Rebindable keys](#rebindable-keys) |

The file is checked field by field: a bad value falls back to its default
with one warning in the status line that names the field, e.g.
`Config: editor.mode "foo" unknown, using "auto"`, and the rest of the file
still applies. A file that cannot be read or is not a JSON object is ignored
with a warning (all defaults) and is never overwritten: saving a change then
fails with a message asking you to fix or delete it. Writes are atomic
(a temporary file, then a rename) and merge into what is there, so keys
eisen does not know are kept, at every level. A v0.1 file such as
`{ "preset": "focus" }` works unchanged. `EISEN_EDITOR_MODE=fullscreen` in
the environment still wins over `editor.display`. The CLI reads only
`preset`.

## Rebindable keys

Every matrix and triage action can have its keys changed, in Settings › Keys
or in the `keys` object of the configuration file. A key list there replaces
that action's default keys; actions not listed keep theirs. Matrix actions are
named by their id (`toggle_done`), triage ones with a `triage.` prefix
(`triage.skip`). An action can have several keys, or none (`[]`) unless it is
guarded (below).

Key strings:

- one character: `a`, `A` (Shift+a), `?`, `.`;
- a name: `space`, `tab`, `up`, `down`, `left`, `right`, `pageup`,
  `pagedown`, `home`, `end`, `f1`–`f12`;
- either one after `ctrl+` and/or `alt+`: `ctrl+d`, `alt+x`. Prefixes and
  names ignore case; a letter after `ctrl+` is always lowercase (terminals
  cannot tell `ctrl+D` from `ctrl+d`).

Rules:

- `Esc`, `Enter`, `Backspace` and `Ctrl+C` can never be bound, and while you
  type (search, quick add, the `:` line, the form, Settings) keys go to the
  input, never to an action.
- `quit`, `help`, `settings` and `command_line` always keep at least one key.
- One key on two actions of the same scope is a conflict (a matrix key and a
  triage key may be the same). Settings refuses it; in the file the
  conflicting override is ignored with a warning and that action keeps its
  default keys.
- An unknown action name, a value that is not a list, or a key that is not
  valid is ignored with a warning (`Config: keys.foo is not an action,
  ignored`); the other overrides still apply.

| Action id (matrix)  | Action                  | Default keys     |
| ------------------- | ----------------------- | ---------------- |
| `move_left`         | Move left               | `h`, `left`      |
| `move_down`         | Move down               | `j`, `down`      |
| `move_up`           | Move up                 | `k`, `up`        |
| `move_right`        | Move right              | `l`, `right`     |
| `send_q1`–`send_q4` | Send to Q1–Q4           | `1`–`4`          |
| `new_task`          | New task                | `a`              |
| `quick_add`         | Quick add               | `A`              |
| `edit`              | Edit                    | `e`              |
| `toggle_done`       | Toggle done             | `x`              |
| `delete`            | Delete                  | `d`              |
| `order_down`        | Move down in the order  | `J`              |
| `order_up`          | Move up in the order    | `K`              |
| `search`            | Search                  | `/`              |
| `triage`            | Triage the Inbox        | `i`              |
| `toggle_done_panel` | Done panel              | `.`              |
| `toggle_preview`    | Preview panel           | `p`              |
| `toggle_bullets`    | Bullets                 | none             |
| `preview_down`      | Scroll the preview down | `ctrl+d`         |
| `preview_up`        | Scroll the preview up   | `ctrl+u`         |
| `command_line`      | Command line            | `:`              |
| `settings`          | Settings                | `,`              |
| `help`              | Help                    | `?`              |
| `quit`              | Quit                    | `q`              |

| Action name (triage)            | Action        | Default keys |
| ------------------------------- | ------------- | ------------ |
| `triage.send_q1`–`triage.send_q4` | Send to Q1–Q4 | `1`–`4`      |
| `triage.skip`                   | Skip          | `s`          |
| `triage.edit`                   | Edit          | `e`          |
| `triage.delete`                 | Delete        | `d`          |
| `triage.help`                   | Help          | `?`          |
| `triage.exit_triage`            | Exit triage   | `q`          |

`Esc` always leaves triage, and `Esc`, `?` and `q` always close the help.

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
