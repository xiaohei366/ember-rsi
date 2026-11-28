# Initial snapshot

### initial-snapshot-destination-comparison

When a change affects destination selection for initial-snapshot preview, rollback, or export, check the case where a later revision changed local files. Preview and rollback should compare the baseline with current destination contents. Export to an empty directory should include the full baseline. Flag a filter that drops required roots, such as one comparing the baseline with itself. An empty rollback preview is valid when the destination already matches the baseline. Later generated revisions may omit roots they left unchanged. Normal write protections still apply.

Source: maintainer-6f2cb93c93d9b91b.
