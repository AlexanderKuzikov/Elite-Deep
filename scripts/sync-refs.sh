#!/usr/bin/env bash
# sync-refs.sh — привести packed-refs в соответствие с реальным состоянием.
#
# Зачем: в этом окружении `.git/refs/remotes/origin/main` не существует как файл,
# ссылка читается только из `.git/packed-refs`. `fetch` и `push` обновляют
# loose-файл (для `refs/heads/main`) и пишут в reflog, но строки в `packed-refs`
# не переписывают. В результате `git status` показывает `[ahead N]` при чистом
# дереве, а `git rev-parse origin/main` отдаёт старый коммит.
#
# Использование: sync-refs.sh [путь-к-репозиторию]
# Идемпотентно: повторный запуск ничего не меняет, если всё уже сходится.

set -euo pipefail

repo="${1:-$PWD}"
cd "$repo"

packed=".git/packed-refs"
[ -f "$packed" ] || { echo "нет $packed — не репозиторий?"; exit 1; }

head_sha="$(git rev-parse HEAD)"
remote_sha="$(git ls-remote origin refs/heads/main | cut -f1)"

if [ -z "$remote_sha" ]; then
  echo "не удалось прочитать origin/main с remote"
  exit 1
fi

if [ "$head_sha" != "$remote_sha" ]; then
  echo "HEAD ($head_sha) != remote ($remote_sha) — сначала push, потом синхронизация"
  exit 1
fi

before="$(cat "$packed")"

python - "$packed" "$remote_sha" <<'PY'
import io, re, sys
path, sha = sys.argv[1], sys.argv[2]
text = io.open(path, encoding="utf-8", newline="").read()
for name in ("refs/heads/main", "refs/remotes/origin/main"):
    text = re.sub(
        r"^[0-9a-f]{40} " + re.escape(name) + r"$",
        sha + " " + name,
        text,
        flags=re.M,
    )
io.open(path, "w", encoding="utf-8", newline="").write(text)
PY

after="$(cat "$packed")"

if [ "$before" = "$after" ]; then
  echo "packed-refs уже актуален: $remote_sha"
else
  echo "packed-refs обновлён на $remote_sha"
fi

echo "проверка:"
echo "  HEAD       $(git rev-parse --short HEAD)"
echo "  origin/main $(git rev-parse --short origin/main)"
echo "  remote     $remote_sha"
echo "  статус     $(git status -sb | head -1)"
