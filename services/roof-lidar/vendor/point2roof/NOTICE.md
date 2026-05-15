# Point2Roof — Vendored Copy

Source: https://github.com/Li-Li-Whu/Point2Roof
License: MIT (see LICENSE)
Vendored at commit: HEAD as of 2026-05-15
Checkpoint: `checkpoint_epoch_90.pth` (trained by the original authors)

## Citation

If/when we ship this in production, the README contains the paper
citation we'd add to our acknowledgements:

> Point2Roof: End-to-end 3D building roof modeling from airborne
> LiDAR point clouds.
> Li Li, Nan Song, Fei Sun, Xinyi Liu, Ruisheng Wang, Jian Yao,
> Shapsheng Cao. ISPRS Journal.

The real training dataset is sourced from RoofN3D:

> RoofN3D: A database for 3D building reconstruction with deep
> learning. Wichmann, Agoub, Schmidt, Kada.
> Photogrammetric Engineering & Remote Sensing 85(6):435–443, 2019.

## Why vendored, not submoduled

The original repo is in maintenance mode (7 commits, no recent
activity). Vendoring lets us:
1. Pin to a known-working snapshot.
2. Patch issues without waiting on upstream.
3. Avoid a submodule init step in CI / Modal builds.

If we want to track upstream changes in the future, this directory
can be replaced by `git submodule add ...` without changing the
wrapper API in services/roof-lidar/point2roof_wrapper.py.

## Local modifications

NONE yet — files are byte-identical to the original repo. Any
patches we apply later should be documented here so a future
"resync to upstream" PR can replay them deliberately.
