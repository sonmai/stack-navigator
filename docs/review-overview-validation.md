# Review overview prototype validation

Automated tests exercise GitHub pagination, safe checkout arguments, stack membership,
immutable snapshot selection, tree caching and mocked native comment display. They do
not prove real VS Code rendering, focus behavior or interoperability with other extensions.

## Manual setup

Run `npm install`, `npm test`, then launch the repository's Extension Development Host with F5.
Use a trusted multi-root workspace with two Git repositories, authenticated `gh`, and a local
gh-stack stack containing at least two PRs with review threads. Enable GitHub Pull Requests.

## Checklist

- Confirm the Stack Navigator icon is visible in the Activity Bar.
- In a fresh workspace, confirm detecting a stack opens the view once without taking editor focus.
- Close the view, refresh, switch branches and reload the window. Confirm it does not reopen automatically.
- Click the Activity Bar icon to reopen the view. Confirm PR numbers, titles and current-branch marker.
- Expand both PRs without checking them out. Confirm decision, CI and unresolved counts.
- Click an unresolved RIGHT-side thread on another PR. Confirm only the owning repo changes
  branch, the correct file opens and the selected thread is expanded at the correct line.
- Repeat in a second repository, including matching filenames across repositories.
- Confirm the tree stays expanded and retains its identity after checkout.
- Change the local file or add unpushed commits. Confirm mismatched content opens read-only.
- Try a LEFT-side thread and an outdated thread. Verify the label distinguishes a full
  historical snapshot from a diff excerpt. No guessed line may be used in the working file.
- Leave an editor unsaved, then click a thread. Confirm checkout is blocked and read-only
  viewing remains available without discarding changes.
- Make changes that prevent Git switching branches. Confirm no stash/reset/force occurs.
- Click threads rapidly. Confirm checkout operations do not overlap.
- Switch branches outside the overview. Confirm the previously displayed native thread disappears.
- Refresh after resolving a thread on GitHub. Confirm the resolved state and count update.
- Compare GitHub Pull Requests enabled/disabled: record duplicate comment widgets, focus,
  scrolling behavior and whether the expanded thread stays visible.

## Prototype limitations

- LEFT-side comments use diff excerpts rather than reconstructed historical base files.
- File-level comments without line coordinates also use the excerpt fallback.
- Review metadata and all replies are loaded when each PR is expanded, not as a background
  stack-wide aggregation. Large threads can take multiple requests.
- No reply/resolve/approve actions, conversation comments, auto-refresh or worktree creation.
- No private commands from GitHub Pull Requests or proposed VS Code APIs are used.
- Snapshots are held in memory until their editors close. Content retrieval uses the existing
  CLI output limit and falls back for binary, oversized or inaccessible files.
