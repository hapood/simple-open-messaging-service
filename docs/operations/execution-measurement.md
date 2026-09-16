# Business and task execution measurement

Set `EXECUTION_MEASUREMENT_SAMPLE_RATE` to a value in the inclusive range from
`0` to `1`. The default is `0`, which disables execution contexts and avoids
installing database driver hooks. A value of `1` measures every annotated
business operation and durable-task handler execution; intermediate values
randomly sample root executions. A child business operation always follows its
sampled parent task so their measurements remain comparable.

Each sampled scope emits one structured `execution_measurement` log when it
finishes. The log contains a correlation `executionId`, operation kind and
name, outcome, wall-clock duration, SQL execution count, database round-trip
count, database failures, and summed database duration. Durable tasks use
`task:<id>` as the correlation ID. Do not use `executionId` or `taskId` as a
metrics label because both have unbounded cardinality.

`sqlExecutionCount` is reported by Drizzle immediately before it invokes the
PostgreSQL driver. `databaseRoundTripCount` is reported at each physical
`pg` client `query()` call, including transaction control statements such as
`BEGIN` and `COMMIT`. This is the practical client-side round-trip unit. It is
not a packet count and does not attempt to split a multi-statement query string.
Queries issued directly through the managed pool contribute to round trips but
not to the Drizzle SQL count.

`databaseDurationMs` is the sum of driver-query durations. Parallel queries can
therefore produce a database duration greater than the operation's wall-clock
duration. `unfinishedDatabaseRoundTripCount` exposes queries that were started
inside an operation but were still running when the operation returned. A
nonzero value usually indicates detached work that should either be awaited or
explicitly moved outside the measured operation.

Annotate only application-level domain entries with
`@MeasureBusinessOperation`; do not annotate SQL helpers or every public
service method. The durable-task dispatcher establishes task scopes centrally,
so individual task handlers require no measurement boilerplate.
