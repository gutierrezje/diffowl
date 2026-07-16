# DiffOwl verification feature map

User-facing capabilities agents should prove against the real CLI. Each file is a recipe: reach → drive → observable end state.

| Feature | Offline? | File |
| --- | --- | --- |
| Hook install / status | Yes | [hook-install.md](./hook-install.md) |
| Findings list (empty) | Yes | [findings-list.md](./findings-list.md) |
| CLI version | Yes | [cli-version.md](./cli-version.md) |
| Model preference (scratch) | Yes* | [model-set.md](./model-set.md) |
| Staged review (JSON) | No (LLM) | [review-staged.md](./review-staged.md) |

\* Writes preference under the scratch cwd only when DiffOwl resolves `.diffowl/` there — still never run `--reset` against the developer's checkout.

Start with an offline feature unless the change under test is in the review path.
