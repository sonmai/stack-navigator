# Stack Navigator

<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="Stack Navigator logo">
</p>

<p align="center"><strong>See your position and navigate GitHub stacked pull requests from the VS Code status bar.</strong></p>

Stack Navigator brings [`github/gh-stack`](https://github.com/github/gh-stack) navigation into the VS Code status bar. See where you are in a stack, identify the current pull request, and move between layers without leaving the editor.

<code>↓&nbsp; 2/4 · &#35;184 Add input validation &nbsp;↑</code>

## Highlights

- See the current stack position, pull request number, and title at a glance.
- Move to the previous or next reachable layer with one click.
- Open a Quick Pick to jump directly to any pull request in the stack.
- Preview the first few lines of the current pull request description in the tooltip.
- See concise `merged`, `queued`, and `needs rebase` status labels.
- Load a stack from the current pull request or from a pasted GitHub pull request URL.
- Enter a stack from trunk, including repositories with multiple local stacks.

## Getting started

1. Install [GitHub CLI](https://cli.github.com/) and authenticate:

   ```sh
   gh auth login
   ```

2. Install the GitHub stack extension:

   ```sh
   gh extension install github/gh-stack
   ```

3. Install Stack Navigator, open a Git repository in VS Code, and check out a branch that belongs to a stack.

Stack Navigator appears in the status bar when it finds a local stack. The built-in VS Code Git extension must be enabled.

## Using the status bar

The middle item shows your position and the current pull request:

<code>2/4 · &#35;184 Add input validation</code>

- Click the down or up arrow to move one reachable layer.
- Click the middle item to choose any layer from a Quick Pick.
- Hover over the middle item to preview the current pull request description.
- Hover over an arrow to see the next reachable pull request.

Merged layers are skipped when `gh-stack` would skip them. At the top or bottom of a stack, the unavailable arrow is hidden.

## Loading a stack

If the current branch has a pull request but no local stack, Stack Navigator offers **Load stack for &#35;184**. This runs `gh stack checkout` for the pull request URL, fetches the stack branches, and may change the checked-out branch.

You can also run **Stack Navigator: Load Stack from PR URL…** and paste a GitHub pull request link. Links to Files, Commits, and Checks tabs are accepted. Stack Navigator verifies that the URL belongs to the selected local repository before loading it.

An ordinary pull request that is not part of a stack may produce an error. Open **Output**, then select **Stack Navigator** to see the details.

## Using Stack Navigator from trunk

When a stack is associated with the current trunk, Stack Navigator stays visible and offers **Go to First Layer**. It enters the first unmerged layer.

If several local stacks share the same trunk, choose **Select stack…** to pick the stack you want. Canceling the picker leaves your checkout unchanged.

## Stack review overview (prototype)

Click the **Stack Navigator** icon in the Activity Bar to see PRs in the current local stack.
PRs appear from the top layer down to the layer nearest trunk. The overview follows the repository of the active code editor, including remote files and Git diffs. When no repository-backed editor is active, it keeps the last repository.
The view opens automatically the first time a stack with PRs is detected in a workspace, without taking editor focus.
After that, it does not reopen automatically on refresh, checkout or window reload.
Review decisions, CI summaries and thread previews load in the background for the whole stack, two PRs at a time.
The current PR loads first; expanding another PR prioritizes it in the queue. Each preview includes the first comment and total comment count.
Expanding does not change branches. Click a thread to check out its local branch and open its code with a read-only native comment thread.

- Matching local files open for editing; outdated comments or differing local content open a read-only PR revision.
- Comments on the old side of a diff show the original diff excerpt, not a guessed location in the working file. Missing historical revisions use the same fallback.
- Checkout never stashes, resets, rebases or forces changes. If blocked, choose **View read-only** to inspect the comment without completing checkout.
- Unsaved file editors must be saved or closed before checkout. The prototype checks all open file editors conservatively.
- Full replies are fetched only for the thread you click, along with fresh code coordinates.
- Use the view's **Refresh** button to reload reviews. Existing data stays visible while updating, and checkout within the same stack retains the cache. There is no periodic polling yet.
- Reply, resolve, general PR conversation comments and advanced filters are not included. Only the selected thread is displayed by Stack Navigator.

This prototype still needs interactive testing alongside GitHub Pull Requests to check for duplicate comment widgets and editor focus behavior. See [the validation checklist](docs/review-overview-validation.md).

## Commands

| Command | Purpose |
| --- | --- |
| **Stack Navigator: Load Stack for Current PR** | Load the stack for the pull request on the current branch. |
| **Stack Navigator: Load Stack from PR URL…** | Load a stack from a pasted GitHub pull request link. |
| **Stack Navigator: Up** | Move to the next reachable layer. |
| **Stack Navigator: Down** | Move to the previous reachable layer. |
| **Stack Navigator: Select PR…** | Choose a layer in the current stack. |
| **Stack Navigator: Go to First Layer** | Enter the first unmerged layer from trunk. |
| **Stack Navigator: Select Stack…** | Choose among local stacks that share the current trunk. |
| **Stack Navigator: Select Repository…** | Choose which repository Stack Navigator should use in a multi-repository workspace. |
| **Stack Navigator: Refresh** | Reload stack and pull request information. |

## Requirements

- VS Code with the built-in Git extension enabled
- [GitHub CLI](https://cli.github.com/) authenticated for the repository
- [`github/gh-stack`](https://github.com/github/gh-stack) installed as a GitHub CLI extension
- A desktop or remote workspace extension host with access to `git` and `gh`

Stack Navigator does not run in a browser extension host. In a workspace with multiple repositories, Stack Navigator follows the repository of the active file and remembers the last repository when no file editor is open. You can also use **Stack Navigator: Select Repository…** to choose one manually.

## Safety

Stack Navigator reads stack and pull request information, then changes only your local checkout when you navigate or load a stack. It never runs `gh stack sync`, `push`, `submit`, or `rebase`. It also never stashes, resets, or forces a checkout.

Loading a remote stack uses `gh stack checkout`, which fetches branches and configures local tracking. If Git cannot safely carry your local changes to another branch, Stack Navigator stops and reports the error.

## Troubleshooting

- Open **Output**, then select **Stack Navigator** for command output and errors.
- If the repository has multiple remotes, configure the intended remote, for example with `git config remote.pushDefault origin`.
- If another local stack already tracks the same branches, resolve that conflict with `gh-stack` before loading the stack again.
- Run **Stack Navigator: Refresh** to clear cached pull request titles and reload the current state.

## Development

```sh
npm install
npm test
```

Open the repository in VS Code and press **F5** to launch an Extension Development Host. Pull requests targeting `main` run the test suite. Every push to `main` also builds a versioned VSIX and publishes it under GitHub Releases.
