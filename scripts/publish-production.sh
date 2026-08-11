#!/usr/bin/env bash
set -euo pipefail

message="${1:-Update production}"
branch="$(git branch --show-current)"

if [[ "${branch}" != "main" ]]; then
  echo "Production publishing is only allowed from main; current branch: ${branch}" >&2
  exit 1
fi

git add -A
git diff --cached --check

if ! git diff --cached --quiet; then
  git commit -m "${message}"
fi

github_key="${GITHUB_SSH_KEY:-${HOME}/.ssh/id_ed25519_github_codex}"
if [[ -f "${github_key}" ]]; then
  git -c core.sshCommand="ssh -i ${github_key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes" push origin main
else
  git push origin main
fi

echo "GitHub push completed. Tencent Cloud deployment is now running in GitHub Actions."
