# Experiment recovery

### experiment-resume-preserves-failure-record

When changes affect in-place resume after an experiment component fails, flag a recovery path that changes the experiment ID or makes the failed attempt's status or diagnostics unavailable after recovery. An explicit restart or fork may use a new experiment ID if the original failure record remains queryable and any promised lineage is preserved.

Source: maintainer-aa9a6a516aeea1c9.
