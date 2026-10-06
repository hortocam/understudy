/**
 * The worked examples from docs/03-config-reference.md, verbatim, one per layer file.
 * Every one must validate against the contract (T010), and each is also the documented
 * example the contract ships (constitution IX).
 */
export const lookupFile = `
entity: InventoryStatus               # lookup table, referenced by FK or enum-from-table
idField: id
rows:
  - { id: 1, code: available }
  - { id: 2, code: held }
  - { id: 3, code: sold }
  - { id: 4, code: cancelled }
`;

export const entitiesFile = `
entity: Venue
rows:
  - { id: 1, name: "Test Arena", city: "Boston", state: "MA", timezone: "America/New_York" }
`;

export const recipeFile = `
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
`;

export const webhooksFile = `
targets:
  pos:
    url: \${USTDY_WEBHOOK_POS_URL:-http://localhost:9000/hooks/pos}
    headers: { X-Source: mock }
    retry: { max: 5, backoff: exponential, baseMs: 500, jitterMs: 200 }
    timeoutMs: 5000

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
`;

export const actionsFile = `
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
          id: "$params.listingId"
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
`;

export const simulationsFile = `
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
`;

export const mappingFile = `
source: { file: ./data/events.json, format: json }
select: "$.events[*]"
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
`;
