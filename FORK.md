# Boole-Digital/openport — Fork of openclaw/openclaw

## Custom Changes

This fork adds Portara trading agent features on top of upstream openclaw:

- Portara slash commands (`/mybalances`, `/mypositions`, `/myorders`, `/mystrategies`, etc.)
- OpenRouter billing error detection
- PM2 heartbeat monitoring
- Custom agent timeout (900s)
- Reasoning mode defaults

## Syncing with Upstream

**Do not use GitHub's "Sync fork" button or create PRs from `openclaw:main` → `Boole-Digital:main`.** GitHub treats upstream's `main` as the head branch, which you can't push to — you'll get "You do not have permission to push to the head branch."

Instead, merge upstream locally on a branch:

```bash
# One-time: add upstream remote
git remote add upstream https://github.com/openclaw/openclaw.git

# Fetch latest upstream
git fetch upstream

# Create a merge branch (keeps main safe)
git checkout -b merge/upstream-sync main

# Merge upstream
git merge upstream/main

# Resolve conflicts — keep our custom code + upstream's changes
# Then commit and push
git push -u origin merge/upstream-sync
```

Then open a PR from `merge/upstream-sync` → `main` on GitHub and review before merging.

### Pre-commit hook notes

- Upstream's pre-commit runs `pnpm check` (lint + typecheck). Extension type errors from missing deps are expected — use `--no-verify` for merge commits if needed.
- Requires **Node 22+**. If using nvm, ensure hooks pick up the right version: `nvm alias default 24`.
