# GitHub PAT Renewal Runbook — `winstat push`

Operational runbook for renewing the **classic** GitHub Personal Access Token used to push to the `wildlifeinneed/winstat` remote. This is a **recurring task** — classic PATs expire, and this account has hit auth pitfalls before. Follow the steps in order and read the gotchas.

---

## 1. Context / When

- **Token:** classic PAT named **`winstat push`**
- **Account:** `wildlifeinneed` (login `wildlifeinneed111@gmail.com`)
- **Used for:** pushing to the `wildlifeinneed/winstat` remote.
- **Trigger:** GitHub emails a **7-day expiry warning**. Renew when you get it (or sooner).
- **Also matters for:** the **capacity-snapshot GitHub Actions workflow**, which commits data back to `main`. A dead token breaks both your local pushes and that workflow.

---

## 2. Required Scopes (all three)

| Scope | Why it's needed |
|-------|-----------------|
| `repo` | Push/pull to the repository. |
| `workflow` | The repo has an Actions workflow that commits data back to `main`; without this scope pushes touching workflow-related refs are rejected. |
| `read:org` | The GitHub CLI (`gh auth login --with-token`) **requires** `read:org` to validate org membership. Without it you get: `error validating token: missing required scope 'read:org'`. |

> **Where to find `read:org`:** on the token scope page it lives **under the `admin:org` group** — expand `admin:org` and check `read:org`.

---

## 3. Renewal Steps

1. Go to **github.com/settings/tokens** and open the **`winstat push`** token. (The **regenerate** link is also in the expiry email.)
2. Set the **expiration**:
   - Pick a date, **or** choose **"No expiration"** to stop the recurring nag.
   - **Security tradeoff:** "No expiration" means a leaked token stays valid forever. Prefer a bounded expiry unless you accept that risk.
3. Ensure **`repo` + `workflow` + `read:org`** are all checked (see §2).
4. Click **Regenerate token** and **copy the new token** (it's shown only once).

---

## 4. Update the Stored Credential (critical gotcha)

Update the credential the CLI/git actually uses:

```bash
gh auth login          # choose GitHub.com → paste the new token when prompted
gh auth switch         # make `wildlifeinneed` the ACTIVE account
gh auth setup-git      # point git's credential helper at the gh-managed credential
```

> **⚠️ Do NOT use the inline-PAT-in-URL trick** (`https://<token>@github.com/...`). It:
> - leaves the token in your **shell history**, and
> - does **not** update the stored credential helper — so the **next push still 403s as the old account**.
>
> Always update the stored credential via `gh auth` as above.

---

## 5. Verify (read-only — proves it works without pushing)

```bash
gh auth status
# expect: active account = wildlifeinneed
#         scopes include repo, workflow, read:org

git -C /Users/P1/Projects/PA-Wildlife-Rehab ls-remote --heads origin
# authenticated read; success (branch refs listed) = credential works
```

Neither command pushes. If both succeed, the renewal is complete.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error validating token: missing required scope 'read:org'` | Token missing the `read:org` scope | Add `read:org` (under `admin:org`) on the token page, regenerate, then re-auth (`gh auth login`). |
| Push returns **403** right after renewal | Stored credential still points at the **old account** | `gh auth switch` (to `wildlifeinneed`) then `gh auth setup-git`; retry push. |
| Actions workflow commit **rejected** on your next local push | Remote `main` **advanced** (workflow committed data back) | `git pull --rebase origin main` then push. **Do NOT force-push.** |
