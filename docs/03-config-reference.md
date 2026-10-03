# 03 — Draft Configuration Reference

All formats are drafts for planning. YAML shown; JSON accepted. Expressions use **JSONata**.

## Project layout

```
understudy/
  understudy.yaml                       # spec, operations, storage, ports, ids
  static/                         # versioned; applied identically every run
    lookups/
      event-categories.yaml
      inventory-statuses.yaml
    entities/
      venues.yaml                 # fixed rows with fixed IDs
  imports/
    events.mapping.yaml
    data/events.json
  dynamic/                        # generation recipes (select with --recipe)
    ci-small.yaml
    load-test.yaml
  behavior/                       # versioned with static
    webhooks.yaml
    actions.yaml
    simulations.yaml
```

## understudy.yaml

```yaml
spec: ./specs/pos-api.yaml            # file or URL
server: { port: 8080, basePath: /v1 }
control: { prefix: /__understudy, port: 8081 }   # separate port optional
storage: { driver: sqlite, path: ./.understudy/state.db }

operations:                           # only these are live; others -> 501
  - POST   /inventory
  - GET    /inventory
  - GET    /inventory/{id}
  - PATCH  /inventory/{id}
  - DELETE /inventory/{id}
  - GET    /events
  - GET    /events/{id}
  - GET    /orders
  - GET    /orders/{id}

entities:
  Inventory:
    idField: id
    relations:
      eventId:  { to: Event.id,  onDelete: restrict }
      venueId:  { to: Venue.id }
    ids: { generatedStart: 100000 }
  Order:
    writes: actions-only              # no API writes, even if the spec had them
```

## static/lookups/inventory-statuses.yaml

```yaml
entity: InventoryStatus               # lookup table, referenced by FK or enum-from-table
idField: id
rows:
  - { id: 1, code: available }
  - { id: 2, code: held }
  - { id: 3, code: sold }
  - { id: 4, code: cancelled }
```

## static/entities/venues.yaml

```yaml
entity: Venue
rows:
  - { id: 1, name: "Test Arena", city: "Boston", state: "MA", timezone: "America/New_York" }
```

## imports/events.mapping.yaml

```yaml
source: { file: ./data/events.json, format: json }
select: "$.events[*]"                         # JSONPath (or `jsonata:` prefix)
targets:
  - entity: Event
    upsertKey: externalId
    fields:
      externalId: "$.id"
      name:       "$.title"
      startsAt:   "$.start_time"
      categoryId: { lookup: EventCategory, by: code, from: "$.category" }
  - entity: Venue
    upsertKey: externalId
    fields:
      externalId: "$.venue.id"
      name:       "$.venue.name"
```

## dynamic/ci-small.yaml

```yaml
seed: 42
entities:
  Event:                                      # already imported; skip generation
    source: import
  Inventory:
    perParent: { entity: Event, range: [10, 50], distribution: zipf }
    fields:
      section:   { generator: sectionCode }
      row:       { faker: "string.alpha", length: 1, casing: upper }
      quantity:  { faker: "number.int", min: 2, max: 8 }
      cost:      { faker: "finance.amount", min: 20, max: 400, dec: 2 }
      price:     { expr: "cost * $uniform(1.1, 2.5)" }
      statusId:  { lookup: InventoryStatus, weights: { available: 0.8, held: 0.1, sold: 0.1 } }
    constraints:
      - "price >= cost"
generators:
  sectionCode: { choice: ["100","101","102","200","201","FLOOR","GA"] }
```
Unlisted entities generate with inferred FKs and the default precedence chain. Counts use `count: N` for non-relative entities.

## behavior/webhooks.yaml

```yaml
targets:
  pos:
    url: ${USTDY_WEBHOOK_POS_URL:-http://localhost:9000/hooks/pos}
    headers: { X-Source: mock }
    retry: { max: 5, backoff: exponential, baseMs: 500, jitterMs: 200 }
    timeoutMs: 5000
    # signing: later slice
    # signing: { alg: hmac-sha256, header: X-Signature, secretFrom: subscription }

subscriptions:
  - name: inventory-sold
    on: Inventory.updated
    when: "$exists(changed[$='statusId']) and after.statusId = 3"
    target: pos
    delay: { minMs: 0, maxMs: 500 }
    template: |
      {
        "type": "inventory.sold",
        "occurredAt": $now(),
        "data": { "id": after.id, "eventId": after.eventId, "quantity": after.quantity }
      }
    faults: { duplicate: 0, drop: 0 }

  - name: inventory-created
    on: "POST /inventory"                      # operation-bound trigger
    target: pos
    template: ./templates/inventory-created.jsonata
```

## behavior/actions.yaml

```yaml
actions:
  marketplace-order:
    description: Simulate an order arriving from the marketplace
    params:
      listingId: { type: integer, optional: true }
      quantity:  { type: integer, default: 2 }
    steps:
      - select:
          as: inv
          entity: Inventory
          id: "$params.listingId"               # optional; else query
          where: "statusId = 1 and quantity >= $params.quantity"
          pick: random
      - fail_if_empty: { var: inv, code: 409, message: "No available inventory" }
      - create:
          as: order
          entity: Order
          fields:
            inventoryId: "$inv.id"
            quantity: "$params.quantity"
            status: "pending"
            # remaining Order fields (buyer, totals, timestamps) come from generators
      - update: { target: inv, set: { statusId: 3 } }
      - webhook:
          target: marketplace
          template: ./templates/order-created.jsonata
          with: { order: "$order" }

reactions:
  - name: cancel-orders-on-listing-delete
    on: Inventory.deleted
    run: cancel-pending-orders
    params: { inventoryId: "before.id" }
```

## behavior/simulations.yaml

```yaml
simulations:
  steady-orders:
    seed: 7
    rules:
      - run: marketplace-order
        every: { range: [20s, 90s] }
        max: 25
      - on: Inventory.created
        probability: 0.2
        after: { range: [30s, 300s] }
        run: marketplace-order
        params: { listingId: "after.id" }
```

## Control-plane quick examples

```
ustdy up --recipe ci-small --webhook-target pos=http://localhost:9000/hooks
curl -X POST localhost:8081/__understudy/actions/marketplace-order/run -d '{"params":{"quantity":4}}'
ustdy reset --to baseline
ustdy export --origin generated > fixtures/generated.json
```

## Reserved / future keys

- `signing` (webhook HMAC) — see `02-architecture.md` §8.
- `clock: { mode: real|virtual, start: … }`
- `storage.driver: postgres`
- `entities.<Name>.relations.<field>.onDelete: restrict|cascade|setNull`
