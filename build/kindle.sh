#!/usr/bin/env bash
# Kindle (AZW3) files for the R2 step of .github/workflows/build.yml; build.py --stage-pdfs runs this once the EPUBs
# are staged (--after-epubs), then reads kindle-manifest.json (KINDLE_MANIFEST) so read pages get their Kindle links.
# Only new or changed books are converted (build/kindle.py, about 2 s a book), within KINDLE_MINUTES; the rest wait
# for the next build. The files live in R2 under kindle/ with kindle/manifest.json. Needs rclone's "r2" remote set up.
set -uo pipefail
EPUBS="$1"
KINDLE_MINUTES="${KINDLE_MINUTES:-25}"
kindle_ok=1
for try in 1 2 3; do
  if rclone cat "r2:$R2_BUCKET/kindle/manifest.json" > kindle-old.json 2> kindle-err.txt; then break; fi
  if grep -qi 'not found' kindle-err.txt; then echo '{}' > kindle-old.json; break; fi
  if [ "$try" = 3 ]; then kindle_ok=0; cat kindle-err.txt; fi
  sleep 10
done
if [ "$kindle_ok" = 1 ]; then
  todo=$(python build/kindle.py plan --epubs "$EPUBS" --manifest kindle-old.json || echo 0)
  echo "Kindle: $todo books need a new Kindle file"
  if [ "$todo" -gt 0 ]; then
    sudo apt-get update -q > /dev/null && sudo apt-get install -y -q --no-install-recommends calibre > /dev/null
  fi
  if python build/kindle.py convert --epubs "$EPUBS" --manifest kindle-old.json --out _kindle --minutes "$KINDLE_MINUTES" \
     && rclone copy _kindle "r2:$R2_BUCKET/kindle" --exclude manifest.json --exclude stale.txt --transfers 16 --stats-one-line -v \
     && { [ ! -s _kindle/stale.txt ] || rclone delete "r2:$R2_BUCKET/kindle" --files-from _kindle/stale.txt -v; } \
     && rclone copyto _kindle/manifest.json "r2:$R2_BUCKET/kindle/manifest.json"; then   # manifest last, once the files are there
    cp _kindle/manifest.json kindle-manifest.json
  else
    echo "::warning::Kindle files not finished this run; keeping the ones already on R2"
    cp kindle-old.json kindle-manifest.json
  fi
  rm -rf _kindle
else
  echo "::warning::Could not read the Kindle manifest from R2; no Kindle files made this run"
  curl -fsS -A "FoggyPress-site-build/1.0" "$PDF_BASE/kindle/manifest.json" -o kindle-manifest.json || true
fi
