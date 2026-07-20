# Enterprise Audit — Developer Guide (ADR-026)

The Audit Kernel is the platform's **immutable, append-only** record of significant business
and platform events for traceability, compliance, and forensics. It is **not application
logging** and **not observability** — every entry is a frozen, checksummed fact linked into a
tamper-evident hash chain.

## 1. Compose

```js
const { createAuditPlatform } = require('../../src/application/audit');
const audit = createAuditPlatform({
  publisher, // EventPublisher port (ADR-016); omit for a null publisher
});
const A = audit.audit;
```

## 2. Record an event (append-only)

```js
const rec = await A.record({
  action: 'trip.created', // required
  actor: 'user:u1', // who
  subject: 'rider:u1', // whom it concerns
  resource: 'trip:t1', // what
  category: 'trip', // grouping
  severity: 'info', // info | notice | warning | critical
  correlationId: 'c1', // ties related records into a timeline
  conversationId, workflowId, messageId, // cross-kernel context
  metadata: { fare: 12.5 },
});
// → frozen record with { auditId, sequence, prevChecksum, checksum, ... }
```

There is deliberately **no update or delete**. Each record is frozen and its `checksum`
chains to the previous record's checksum.

## 3. Query + get (timeline reconstruction)

```js
await A.query({ filter: { correlationId: 'c1' } }); // full timeline for a correlation
await A.query({ filter: { workflowId: 'wf-1', severity: 'critical' } });
await A.query({ filter: { from: t0, to: t1 }, sort: 'desc', limit: 50 });
await A.query({ filter: { 'metadata.fare': 12.5 } });
await A.get(namespace, auditId);
```

Filters are exact-match on record fields plus a `from`/`to` timestamp range and `metadata.*`
dotted paths. Results are ordered by append sequence (ascending by default).

## 4. Verify integrity

```js
const v = await A.verify({ namespace: 'default' });
// → { ok, checked, issues: [{ auditId, sequence, reason }] }
```

`verify` recomputes every record's checksum, checks each `prevChecksum` links to the previous
record, and checks the sequence is contiguous. Any tampering (altered content, rewritten hash,
reordering, or a gap) is reported; an `AuditIntegrityFailure` event is published (and
`AuditVerified` on success).

## 5. Events (through the port only)

`AuditRecorded` (a summary — auditId/action/actor/category/severity/correlation, not full
metadata), `AuditVerified`, `AuditIntegrityFailure` — all via the Event Backbone, producer
`audit`. The EventBus is never exposed.

## 6. Observability

```js
audit.metrics.snapshot(); // records written, queries, verification/checksum/provider failures,
// query latency, uptime
audit.metrics.prometheus();
await A.health();
```

## 7. SDK integration (ADR-018)

```js
const { toAuditPort } = require('../../src/application/audit/sdkAdapter');
const portFactories = {
  'audit:read': () => toAuditPort(audit.audit, { owner: extId, canWrite: false }),
  'audit:write': () => toAuditPort(audit.audit, { owner: extId }),
};
// Inside the extension: this.audit().record({ action: 'thing.happened' })
```

Every record/query/verify is forced into the extension's namespace (`ext.<owner>`) with the
`actor` defaulted to the owner, so an extension can only read and append to its own audit
trail. `record` requires `audit:write`; `query`/`get`/`verify` require `audit:read`.

## Out of scope (future work behind the provider port)

Durable append logs (Storage/PostgreSQL/MongoDB/object storage), retention/rotation, and
cross-shard chains are declared extension points, not implemented in this phase. This is not
application logging.
