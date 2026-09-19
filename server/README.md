# OpenKT BFF

This workspace is the new SGS backend foundation for OpenKT.

Current scope:

- `apps/server` is the canonical HTTP backend shell.
- `apps/worker` is the async worker shell for the future memory engine.
- `libs/` holds shared context, config, logging, and database boundary primitives.

This workspace is intentionally separate from the current Next backend. The migration will move backend ownership here in phases.

## Worker queue backend

RabbitMQ remains the local and backward-compatible default. To run the
pipeline on Amazon SQS, set:

```dotenv
OPENKT_QUEUE_BACKEND=sqs
AWS_REGION=ap-south-1
OPENKT_SQS_COMMAND_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/ACCOUNT_ID/openkt-commands.fifo
OPENKT_SQS_WAIT_TIME_SECONDS=20
OPENKT_SQS_VISIBILITY_TIMEOUT_SECONDS=300
OPENKT_SQS_VISIBILITY_HEARTBEAT_SECONDS=60
OPENKT_SQS_SHUTDOWN_GRACE_SECONDS=30
OPENKT_SQS_MAX_MESSAGES=8
```

The worker uses long polling, processes up to ten messages per receive, and
deletes each message only after the pipeline handler succeeds. While a job is
running, it renews the message visibility timeout every 60 seconds; the
heartbeat interval must be no more than half of the visibility timeout. Failed
deliveries and duplicate deliveries whose ledger job is still running are
left in the queue for visibility-timeout retry. Configure an SQS dead-letter
queue/redrive policy on the command queue to cap retries.

On shutdown, the consumer stops receiving new messages but continues renewing
visibility for active handlers while they drain. After
`OPENKT_SQS_SHUTDOWN_GRACE_SECONDS`, it releases any remaining leases so SQS
can retry them. Set the Dokku stop timeout above this grace period.

Both Standard and FIFO queues are supported. For a queue URL ending in
`.fifo`, the publisher derives a stable message group from the aggregate or
project identity and uses the pipeline message ID for deduplication. Messages
from the same group are handled sequentially; different groups can run in
parallel.

On EC2, attach an instance role that grants `sqs:ReceiveMessage`,
`sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`,
`sqs:GetQueueAttributes`, and `sqs:SendMessage` on the command queue. Do not
put long-lived AWS access keys in Dokku environment variables; the AWS SDK
automatically uses the instance-role credentials.

`OPENKT_SQS_EVENTS_QUEUE_URL` is optional. When unset, stage-completion events
are not exported, while command processing remains fully enabled. When set,
the worker only publishes to that queue; it does not consume it. Grant
`sqs:SendMessage` on the events queue in that case, with no receive/delete
permissions required there.
