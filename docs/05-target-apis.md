# 05 — Target APIs

The two integrations that drive this project's design, measured directly rather than assumed.
Filed 2026-10-03 from live documents; measurements re-verified 2026-10-04.

This document is the **in-repo source of truth** for the vendor facts the slice-2 planning depends
on. It deliberately does not link to any out-of-repo notes.

## 1. StubHub Point of Sale API — machine-readable spec available

| | |
|---|---|
| Human docs | <https://pointofsaleapi.stubhub.net/swagger/index.html> |
| Machine-readable | <https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json> |
| Retrieved | 2026-10-03T05:04:47Z |
| Size / sha256 | 910,770 B / `2209392493d38a6f2a401a69537df01795adc32609e272c62ccb0b78e1c0af90` |

This is the **real vendor document** the original handoff assumed was unavailable (open question
Q6, "run the inference against the actual spec early"). It is live: re-fetch and compare the hash to
detect vendor drift — the same signal the tool itself implements via `_understudy_meta.spec_hash`.

> **Not vendored into this repository.** Redistribution terms for the published document are not
> settled, so the spec is *not* committed here. Fetch it on demand (or reference the URL in
> configuration) until a licence check says otherwise. CI must not depend on it being present.

**Shape** (measured, not estimated):

- OpenAPI **3.0.1**, not 3.1 — so the 3.0→3.1 upgrader gets exercised on real input, not only on a
  fixture.
- **165 paths, 224 operations.** Nothing like the fixture's five.
- **0 of 224 operations declare an `operationId`.** Selection by `operationId` is impossible against
  this document; `METHOD /path` is the only selector that works.
- 28 tags, and **every one of the 224 operations carries a tag** (0 untagged) — so tag selection is
  complete. There is **no top-level `tags` array**; tags exist only as per-operation strings, so a
  tool must gather them by walking operations.
- Tag list: AccountingEventExport, Accounts, ConsigneeGroups, Consignees, CurrencyConversionOverride,
  Customers, Deals, Event, EventDeliveryOverrides, EventListings, HealthCheck, Holds, Inventory,
  InventoryGroup, InventoryPricing, InvoiceLineItems, InvoicePayments, Invoices, Market Orders,
  PurchaseOrder, PurchaseOrderPayments, PurchasePaymentMethod, PurchaseVendor, PurchaseVendorAccount,
  SponsoredListings, Teams, TicketGroups, **Webhook**.
- **One tag contains a space** (`Market Orders`), which the configuration grammar must accommodate.
  See §1.1.
- `Invoices` alone covers 32 operations and `Inventory` 30 — a tag is a far more usable selector than
  165 path templates.
- A **`Webhook`** tag exists → see §2.
- Path shapes: 57 with no parameter, 94 with one, 14 with two (nested sub-resources).
- Three declared response media types per operation — `application/json`, `text/json`, `text/plain` —
  an ASP.NET default. Response negotiation must not choke on it.
- **No `application/hal+json`** — plain JSON, unlike viagogo.

### 1.1 Selection grammar consequence

The configuration's `operations` entries and any tag selector share one grammar. Tag names may
contain spaces, so the canonical form normalises a space to `_` (`Market Orders` → `Market_Orders`),
with the raw vendor string accepted too (exact match first). An ambiguous collapse — a document
holding both `Market Orders` and `Market_Orders` — must refuse to start and name both.

**This normalisation is scoped to identifiers the user selects or writes in configuration.** Values
derived from the document — property names, enum values, paths — are reproduced **verbatim**: the
mock may differ from the real service in *state*, never in *shape*.

**Identity (Q5) — answered, and it is not one kind.** Mixed *within the one document*:

| Path-parameter type | Count | Examples |
|---|---|---|
| `integer<int64>` | 78 | `currencyConversionOverrideId`, `eventId` |
| `string` | 36 | `externalId`, `email` |
| `integer<int32>` | 30 | `viagogoEventId` |
| `string<uuid>` | 29 | `groupId`, `consigneeId` |
| `boolean` | 2 | filter flags, not identities |

Vendor-prefixed identifiers (`viagogoEventId` on a *StubHub* API) are a real convention here. Any
reserved-range design must cope with uuid and prefixed-string identities, not just integers.

**Pagination (Q4) — answered.** Paging is **query-parameter driven, not a uniform response
envelope**: `maxPageSize` (×18) and `paginationToken` (×21, a cursor) are the common parameters, and
only five component schemas carry wrapper fields (`totalCount`, `pageNumber`, `pageSize`,
`nextPageToken`). The response shape follows the schema, not an envelope. The paging heuristic must
cover **a cursor token in a response schema plus a size cap** — not the offset/limit or page/size
forms named first in planning.

**Relationships (Q6) — answered.** FK-looking properties follow `<Entity>Id` camelCase consistently
— `inventoryId`, `purchaseOrderId`, `sellerAccountId`, `marketplaceListingId`, `vendorAccountId`,
`ticketId`, `saleId` (70 distinct names) — so the naming-convention rule hits often *and* has real
collisions: `externalId` appears **45 times** and means a different external system per entity, and
`eventId` / `viagogoEventId` / `primaryEventId` coexist on the same resources.

## 2. The `Webhook` tag — the vendor's registration surface

This is **the registration API a consumer calls to register for webhooks** — a CRUD collection over
`/webhooks`, not a delivery mechanism and not the event payloads. Probed operation by operation:

| Operation | Summary | Notes |
|---|---|---|
| `POST /webhooks` | Register New Webhook | body `PosWebhookCreateRequest`; 200 / **400 / 409 Conflict** |
| `GET /webhooks` | Get All Webhooks | list |
| `GET /webhooks/{webhookId}` | Get Webhook By Id | 200 / 404 |
| `PATCH /webhooks/{webhookId}` | Update Webhook | body `PosWebhookUpdateRequest`; 200 / 400 / 404 |
| `DELETE /webhooks/{webhookId}` | Delete Webhook | 200 / 404 |
| `GET /webhooks/topics` | Get all webhook topics | reference data |
| `GET /webhooks/subtopics` | Get all webhook subtopics | reference data |

Consequences:

- The `Webhook` tag is **an ordinary mocked CRUD entity** — it gets no special linked behaviour that
  actually delivers a notification. It is mocked like any other collection, and outbound webhook
  *delivery* remains the separate feature it always was.
- `409 Conflict` on create is the first **non-404** declared error in the target set, and is worth
  exercising: declared-error rendering is otherwise only proven for not-found.
- Topics and subtopics are reference data — a natural static fixture.

## 3. viagogo API — no machine-readable spec published

| | |
|---|---|
| Docs | <https://developer.viagogo.net/docs/overview/introduction> |
| Inventory reference | <https://developer.viagogo.net/api-reference/inventory> |
| Media type | `application/hal+json` (HAL: `_links` + `_embedded`) |
| Auth | OAuth2, scopes like `write:sellerlistings` |
| Hosts | prod `https://api.viagogo.net/v2/…` · sandbox `https://sandbox.api.viagogo.net/v2/…` |

Probed for a machine-readable document on 2026-10-03 — `developer.viagogo.net/openapi.json`,
`/api-reference/inventory/openapi.json`, `/docs/openapi.yaml`, `api.viagogo.net/openapi.json`,
`/v2/openapi.json` — **all 404**, and the docs site links no spec. The reference is ReDoc-rendered,
so a document exists internally but is not served.

**Consequences:**

- viagogo cannot be a fixture *source*; a document must be hand-authored or scraped before the tool
  can consume it.
- It is the **HAL** case. The design says plain REST/JSON, and every viagogo response is
  `application/hal+json` with `_links`/`_embedded` hypermedia. Mocking it faithfully means either
  modelling `_links` as ordinary reserved schema properties (plausible — HAL *is* plain JSON with
  reserved keys) or building a hypermedia-aware layer (out of scope). Option one is the honest
  reading and should be **verified against a real payload** before the design assumes it.
- Its listing resource carries `external_id` ("an identifier assigned in an external inventory
  management system") — a second, independent occurrence of the external-identity pattern behind the
  StubHub `externalId` collision.

## 4. What this changes in the plan

| Question / assumption | Was | Now |
|---|---|---|
| Q4 pagination conventions | deferred | answered — cursor-in-schema + `maxPageSize`, not offset/limit |
| Q5 identity types | "whatever the document declares" | answered — mixed i64 / uuid / string **within one document**; vendor-prefixed strings are real |
| Q6 FK naming consistency | deferred to a spike | answered — consistent `<Entity>Id`, with `externalId` colliding 45× |
| Q9 consumer-created subscriptions | open | **in scope for the target**: the vendor's `Webhook` tag is a registrable CRUD surface (§2) |
| FR-002 "select by `operationId` or `METHOD /path`" | operationId assumed usable | **falsified** — 0/224 have one; `METHOD /path` is the only selector on the real target, and tags are the ergonomic one |
| "REST/JSON only, no hypermedia" | assumption | needs verifying — viagogo is HAL throughout (§3) |

These belong in the data-layer slice's planning (relationship inference, paging, identity) and in the
recorded revision of the core slice's FR-002 assumption.

The real document is also the highest-value integration fixture available: it exercises the
3.0→3.1 upgrader on real input and is the honest test of inference at scale. A task should run the
derivation against it and record how much pinning it actually needs. **Subject to the licence check
in §1** — fetch on demand rather than committing it.

## 5. Handling

- Both hostnames above are the only vendor endpoints needed, and both are **public and
  credential-free** for documentation and spec retrieval — no API key is used, and none is needed to
  *read* a spec; only *calling* the APIs needs OAuth2.
- Treat a StubHub spec hash change as "the vendor changed the contract".
