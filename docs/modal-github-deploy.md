# Deploying the Modal LiDAR Service via GitHub

Two ways the `voxaris-roof-lidar` Modal app can be deployed:

| Method | When | Cost |
|---|---|---|
| Manual: `modal deploy modal_app.py` from a developer machine | Initial setup, debugging, urgent re-deploys | Free workflow time |
| GitHub Actions: `Deploy Modal LiDAR Service` workflow | Routine deploys after code changes | ~5-15 min of `ubuntu-latest` runner time + Modal image-build compute |

## One-time setup: GitHub Secrets

The GitHub Actions workflow needs Modal API credentials. **The Modal
account owner does this once** in the repo settings:

1. Run `modal token new` locally to get a fresh token pair.
2. GitHub repo → Settings → Secrets and variables → Actions.
3. New repository secret: `MODAL_TOKEN_ID` (value starts `ak-`).
4. New repository secret: `MODAL_TOKEN_SECRET` (value starts `as-`).
5. Confirm both appear in the secrets list.

Verify via the `Verify Modal auth + show app info` step in the first
workflow run — it should list any existing apps without auth errors.

## Triggering a deploy

### Manual (recommended for the first Point2Roof activation)

1. GitHub repo → Actions tab.
2. Left sidebar → **Deploy Modal LiDAR Service**.
3. Right side → **Run workflow** button.
4. Pick the environment (default `main`).
5. Click **Run workflow**.

Watch the live log. The image build is the slow step — first deploy
after this PR will take **3-5 min longer** than today because it
installs the CUDA toolkit + builds the `pc_util` C++/CUDA extension.

### Automatic (only on services/roof-lidar/** changes)

The workflow is scoped to fire only when files under
`services/roof-lidar/` (or the workflow file itself) change on a push
to `main`. UI commits, picker tweaks, etc. don't trigger a Modal
rebuild — this is the cost control. Unrelated commits won't burn
your Modal compute.

## Confirming the deploy

After the workflow finishes (~10-15 min on the cold path, ~3-5 min
warm rebuild):

1. Hit `/api/lidar-health` on the Next.js side. Expected response:
   ```
   { "state": "configured", "service": { "ok": true, "service": "voxaris-roof-lidar" } }
   ```

2. Run a real estimate against `8450 Oak Park Rd, Orlando FL 32819`.

3. Check the Modal app's logs for the magic line:
   ```
   regularize+point2roof: N facets out (M ms)
   ```
   If you see it, Point2Roof is firing. If you see:
   ```
   WARN: pc_util build failed — Point2Roof tier will fall through
   ```
   the CUDA extension didn't compile — the image was built but
   Point2Roof is dormant. Tell us which CUDA version + torch wheel
   showed up in the build log so we can pin a working combo.

4. Watch for `[polyfit-failure]` lines in Modal logs. Each one is a
   structured JSON payload telling us which tier won per address.

## Common failure modes

- **`modal: command not found`** in the workflow — pip install
  step failed. Check the runner has Python 3.12 + matching
  `setup-python` cache hit.
- **`Authentication failed`** — secrets aren't set or the tokens
  expired. Run `modal token new` again, update both secrets.
- **CUDA build out-of-memory on Modal** — the `pc_util` build is
  fairly small (~50 MB), shouldn't OOM. If it does, the base
  image's free memory is the culprit; bump to a beefier builder.
- **The workflow took 25+ minutes** — the CUDA toolkit install or
  the torch wheels are the slow parts. Acceptable for first
  deploy; subsequent deploys hit the image cache and finish faster.
