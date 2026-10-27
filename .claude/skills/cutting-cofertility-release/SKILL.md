---
name: cutting-cofertility-release
description: Use when upgrading Cofertility's Twenty fork to a newer upstream release, cutting or rebuilding a cofertility/v<version> release branch, building the Cofertility image, or deploying a new image tag to dev or prod.
---

# Cutting a Cofertility release

A release is an upstream tag plus `cofertility/infra` plus the branches in `cofertility/release-branches`, built by `cofertility/release.sh` (alias `git cofertility-release`). Deploy config lives in `~/Developer/Repositories/cofertility-twenty/infra/tofu`. The fork is public: nothing is pushed, built or applied until the user says so.

## Steps

1. **Pick the version.** `gh release view -R twentyhq/twenty` gives the latest published release (upstream tags versions before publishing notes; ignore unpublished tags). Compare with the deployed version: `twenty_image_tag` in `environments/<env>.tfvars`, else the default in `variables.tf`. If `cofertility/v<version>` already exists for the latest release, there is no upgrade: skip to step 2 and only rebuild if a feature branch changed. Read the release notes and `packages/twenty-docs/developers/self-host/capabilities/upgrade-guide.mdx` at the new tag for breaking changes, new required env vars and database requirements. Report them.
2. **Bring feature branches current.** For each branch in `release-branches`, `git cherry upstream/main <branch>`: if every line starts with `-`, upstream merged it, so propose dropping it from `release-branches`. Otherwise rebase it onto `upstream/main` in a scratch worktree (the main checkout runs the dev server) so its upstream PR stays mergeable. Each feature stays one commit with a subject line only. A clean rebase leaves the patch unchanged and needs no rebuild; a rebase with conflicts does, followed by a force-push of the release branch.
3. **Build.** `git cofertility-release <version>` (`--rebuild` if the branch exists). On a conflict, resolve it in the worktree the script prints, finish the cherry-pick, and re-run with `--rebuild`; rerere replays it. `yarn.lock` conflicts resolve themselves.
4. **Verify the release branch.** The script deletes its worktree, which had no `node_modules` anyway. Stash uncommitted work in the main checkout, `git switch cofertility/v<version>`, then:
   - `npx nx build twenty-shared --skip-nx-cache`
   - `npx tsgo -p tsconfig.json --noEmit` in `packages/twenty-server` and `packages/twenty-front`
   - the specs touched by each feature commit (`git show --stat <commit>`)
   - restart `npx nx start` and check UI features in the browser at about 1280px
5. **Stop for review**, then push the rebased feature branches and the release branch with `--force-with-lease`.
6. **Disable new workflows after pushing.** Pushing registers any new upstream workflow file as active, so `release.sh`'s check runs too early to catch them. List and disable everything but the image build:
   ```bash
   gh api repos/Cofertility/twenty/actions/workflows --paginate --jq '.workflows[] | select(.state=="active" and .path!=".github/workflows/cofertility-image.yaml") | .id' \
     | xargs -I{} gh api -X PUT repos/Cofertility/twenty/actions/workflows/{}/disable
   ```
7. **Build the image.** The workflow needs the `ECR_REPOSITORY_URL` and `AWS_ROLE_ARN` repository secrets (`gh secret list -R Cofertility/twenty`). ECR tags are immutable, so take the next free `v<version>-cofertility.<n>`:
   ```bash
   aws ecr list-images --repository-name cofertility/twenty --region us-west-2 --query 'imageIds[].imageTag'
   gh workflow run cofertility-image.yaml -R Cofertility/twenty --ref cofertility/v<version> -f tag=v<version>-cofertility.<n>
   gh run watch -R Cofertility/twenty
   ```
8. **Deploy, dev then prod, each after the user's go-ahead.** First run `git status` in cofertility-twenty: uncommitted tofu changes ride along with any apply, so ask the user about them before planning. Upgrade migrations run when the new container starts and can't be undone by reverting the tag, so snapshot first:
   ```bash
   aws rds create-db-snapshot --db-instance-identifier twenty-<env>-postgres --db-snapshot-identifier twenty-<env>-pre-v<version with dots as dashes>-cofertility-<n>
   ```
   Snapshot names allow only letters, digits and hyphens, e.g. `twenty-dev-pre-v2-51-0-cofertility-1`.
   Set `twenty_image_tag` in `environments/<env>.tfvars`. If that env is still on the stock `twentycrm/twenty` image, the first switch also needs `twenty_image_repository` (`tofu -chdir=infra/tofu/shared output -raw ecr_repository_url`) and the `cf_access_*` values (the AUD comes from that env's Access application in the Cloudflare dashboard); see `infra/tofu/README.md`. Then `tofu init -reconfigure -backend-config=environments/<env>.backend.hcl`, `tofu plan -var-file=environments/<env>.tfvars`, show the plan, `tofu apply`. Check `aws logs tail /ecs/twenty-<env>` for upgrade errors and `Cloudflare Access sign-in rejected`, then sign in through Access.

## Common mistakes

| Mistake | Instead |
|---|---|
| Taking the newest `twenty/v*` tag | Latest published release |
| Testing in the release script's worktree | Release branch in the main checkout |
| Checking workflows only before pushing | Check again after every push |
| Reusing or guessing `-cofertility.1` | Next free tag in ECR |
| Applying `AUTH_PASSWORD_ENABLED=false` to an env on the stock image | Ship it in the same apply as the fork image and `cf_access_enabled = true`; otherwise nobody can sign in |
| Deploying without a snapshot | Snapshot RDS first |
