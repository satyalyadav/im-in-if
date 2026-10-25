# Issue tracker

Issues and specs live in GitHub Issues for
`satyalyadav/im-in-if`. Use the `gh` CLI.

## Operations

- Create issues with `gh issue create`. Put multiline bodies
  in a temporary file and pass `--body-file`.
- Read an issue with
  `gh issue view <number> --json number,title,body,labels,comments`.
- List issues with `gh issue list`, using the appropriate
  state and label filters.
- Use `gh issue comment`, `gh issue edit`, and `gh issue close`
  for comments, labels, assignments, and closure.
- Use native GitHub blocking relationships. If unavailable,
  list blocking issues in the ticket body.
- When a source issue exists, link derived tickets as native
  sub-issues. If unavailable, add `Part of #<parent>` to each
  child and link children from the parent.

Before opening an issue or PR, check contribution guidance
and search open and closed issues, PRs, and Discussions if
enabled. If a possible match exists, summarize it and ask the
user whether to extend it or open a separate report.
Read the thread before posting a substantive comment.

When a skill says to publish a ticket, create a GitHub issue.
When it says to fetch a ticket, read its body and comments.

## Pull requests

PRs as a request surface: no.
