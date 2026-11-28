# Resource paths

### resource-ancestor-alias-write-guard

When a change affects resource grouping, load or run path resolution, or in-place write validation, check that supported aliases to the same resource group by canonical path and remain usable for loading and running. Before allowing an in-place write, validate the configured path for ancestor links. A supported ancestor junction may be usable for loading and running while in-place writes through it are blocked. Paths that escape a declared resource boundary may be rejected.

Source: maintainer-6f2cb93c93d9b91b.
