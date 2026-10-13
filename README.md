<p align="center"><img src="assets/header.svg" alt="BlueCheck Technology, Mission Control" width="900"></p>

# Mission Control

A dashboard for every Claude Code session on your computer. It shows what each session is doing and which ones are waiting on you. Each running session gets a Stop button.

![Mission Control docked beside a Claude Code session](assets/dashboard.png)

## Install

![Installing Mission Control: run the command, press y, press Enter, type /mc](assets/install.gif)

1. In Claude Code, run:
   ```
   /plugin install mission-control --marketplace LazarTaub/Claude-Dashboard-by-BlueCheck-Tech
   ```
2. Press `y` to add the marketplace.
3. Press Enter to install it for you.
4. Type `/mc`.

It works right away in that session. Sessions that are already open pick it up when you restart them.

Run the command in a terminal session: the desktop app's Code tab doesn't accept `/plugin`. Once installed, the dashboard loads in the desktop app too.

Project names and branches come from `git`. The PR column needs the GitHub CLI (`gh`), signed in.

## Use

A Mission Control row sits just above the prompt with the live counts. Click **Open Mission Control** to open the dashboard, or press ctrl+x, then Tab, then Enter. Fold the row away with its `[-]`.

![The Mission Control row above the prompt, and the dashboard it opened](assets/button.png)

- `/mc` also opens the dashboard. `/mc breev` opens it with a search already typed.
- The search box filters by project, branch, prompt, PR number or status.
- Tab moves between buttons and Enter presses one.
- Stop ends that session's current turn.
- Resume copies the command that reopens that session in a terminal.
- Every session's status line shows the counts, for example `mission-control: 1 waiting · 2 running · 3 idle`.

Sessions are grouped by project. Worktrees of one repository share a group. Projects with a session waiting on you come first.

| Status | Meaning |
| --- | --- |
| running | A turn is in progress. The line under it shows the current tool. |
| waiting on you | A permission prompt or a question is open. |
| idle | Claude finished its turn. |
| lost | No heartbeat for 2 minutes, so the terminal closed or the process crashed. |
| done | The session ended. Done and lost sessions leave the board after 24 hours. |

## Pull requests

If the GitHub CLI (`gh`) is installed and signed in, each row shows its branch's pull request: the CI result, the latest `Confidence: N/5` from the Claude review comment, and the number of open review threads. It checks after every turn and every 2 minutes.

## BlueCheck Boards

If your BlueCheck connector is connected, each session's work also becomes a card on BlueCheck, with nothing to type:

- **A board per project.** The first request in a session finds the board named like the project, or makes it. Any missing columns are added: To do, In progress, Waiting on you, Review, Done.
- **A card per session.** It's titled from your request and starts in In progress.
- **It moves on its own.** Waiting on you at a permission prompt or a question, back to In progress when work goes on. When a turn ends, it goes to Review if the branch has an open pull request, otherwise to Done (marked done).
- **A note after every turn.** A short comment says what was done, how long it took, and the pull request with its CI.
- **Claude uses the board too.** Each session is told its card and board, so Claude keeps a checklist for long jobs, adds To do cards for follow-ups it finds, and comments on related cards on other boards, like the BlueCheck Roadmap.

`/mc-boards` shows this session's card, the connector it uses, and the last problem if an update failed. `/mc-boards off` turns the updates off, and `/mc-boards on` turns them back on.

## How it works

Each session writes a small JSON file to `~/.claude/mission-control/sessions/` (under `CLAUDE_CONFIG_DIR` if you set it). It writes when a turn starts, when a tool runs, when a turn ends, and every 30 seconds. Each session reads the folder every 4 seconds. The file holds the project, branch, status, current tool and the first 140 characters of your last prompt. Nothing leaves your computer except the `gh` calls to GitHub and, with BlueCheck Boards, the calls to your BlueCheck connector.

Stop sends the other session a short message carrying a random token from that session's file. The other session's copy of Mission Control checks the token, removes the message before Claude reads it, and ends the turn. A message without the right token goes through untouched.

## Limits

- It covers one computer. Cloud sessions and other computers don't appear.
- Stop only reaches sessions that have Mission Control loaded. Sessions started before you installed it need a restart first.
- Stop ends the turn, but a shell command that was running keeps going in the background. The stopped session lists it as "1 shell", and you can end it there. Esc in that session kills the command instead.
- Resume copies a command. It can't bring another terminal window to the front.
- After you approve a permission prompt, a Bash command in a terminal switches back to "running" right away. Other tools stay at "waiting on you" until they finish.
- BlueCheck Boards needs the BlueCheck connector in the session. The first request in a session can take a few seconds longer while the board and card are made.
- Tested on Linux with Claude Code 2.1.292. macOS and Windows should work but haven't been tested yet.

## Tested

Two live Claude Code sessions, A and B, in one terminal:

1. B ran a long command. A's dashboard listed it as running with a Stop button (the screenshot above).
2. A pressed Stop on B. B's turn ended, nothing appeared in B's conversation, and both status lines went to `2 idle`.
3. B hit a permission prompt and its row read "waiting on you". After approval it read "running" again.

| B before Stop | B after Stop |
| --- | --- |
| ![B running a long command](assets/B-running.png) | ![B idle after Stop](assets/B-after-stop.png) |

`claude plugin test .` runs 20 tests: the status, grouping, search and PR parsing, plus the pane drawn on the terminal and the desktop app at full and narrow widths, the row above the prompt and its button, the Stop message and its token check.

## Develop

```
git clone https://github.com/LazarTaub/Claude-Dashboard-by-BlueCheck-Tech
cd Claude-Dashboard-by-BlueCheck-Tech
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The first time Claude Code loads the mod it writes its API types to `.claude-plugin/types/`. After that, `npx tsc -p .` type-checks the code.

`hooks/core.ts` holds the logic, `hooks/register.tsx` wires it to Claude Code events and draws the pane, and `hooks/brand.ts` holds the BlueCheck colors and mark.

## License

MIT. See [LICENSE](LICENSE).

<p><img src="assets/footer.svg" alt="Prepared by BlueCheck Technology" width="900"></p>
