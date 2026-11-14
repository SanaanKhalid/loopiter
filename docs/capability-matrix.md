# Pack versus published alpha

What a pack built from this repository contains, compared with the published alphas.
Building this page does not publish a release.

| Surface | This repository | Published 0.3.0-alpha.1 and 0.3.0a1 |
| --- | --- | --- |
| Setup module | Node `loopiter/onboarding` and Python `loopiter.onboarding` are in the pack. | Not in those archives. |
| Agent guide | `AGENT_GUIDE.md` is packed, and the setup module reads that file. | Not in those archives. |
| Observation modules | Node packs `loopiter/integrations/observe` and `loopiter/integrations/otel`, plus `docs/application-observation.md`. Python packs that observation document next to the guide. | Not in those archives. |
| Python entry point | `python -m loopiter`, from `loopiter/__main__.py`. | Not in the published 0.3.0a1 archive. |
| Mode default | Constructing ImprovementController with no mode is autonomous, with self-improving on, in Node and in Python. | The published 0.3.0-alpha.1 and 0.3.0a1 packages default that controller to recommend and still require `--enable`. |

The install check packs this tree, installs the tarball, wheel, and sdist into clean projects, and runs init plus one local tick from those installs.
