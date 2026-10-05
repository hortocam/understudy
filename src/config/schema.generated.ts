// GENERATED FILE — do not edit by hand.
// Source: specs/001-slice-1-core/contracts/config.schema.yaml
// Regenerate with: npm run generate
export const configSchema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://understudy.dev/schemas/config.schema.json",
  "title": "understudy project configuration",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "spec",
    "operations"
  ],
  "properties": {
    "spec": {
      "type": "string",
      "description": "Path or URL of the OpenAPI 3.0/3.1 document. A URL is the only outbound network call the tool ever makes.",
      "examples": [
        "./specs/pos-api.yaml",
        "https://example.test/openapi.json"
      ]
    },
    "operations": {
      "type": "array",
      "minItems": 1,
      "description": "The operations to make live. Everything else answers 501. Empty or unknown entries refuse to start.",
      "items": {
        "type": "string",
        "minLength": 1,
        "description": "Either 'METHOD /path' (e.g. 'POST /inventory') or an operationId (any non-empty string). Both forms are peers: a document may support only one of them, so neither is a fallback. An operationId is NOT constrained to an identifier shape — OpenAPI only requires it to be a unique string, and real documents use hyphens and dots (e.g. 'get-widgets', 'api.getWidgets'). A genuinely unknown entry is refused at startup by name, not by this pattern.",
        "examples": [
          "POST /inventory",
          "getInventoryById",
          "get-widgets",
          "api.getWidgets"
        ]
      }
    },
    "server": {
      "type": "object",
      "additionalProperties": false,
      "description": "The mocked surface.",
      "properties": {
        "port": {
          "type": "integer",
          "minimum": 0,
          "maximum": 65535,
          "default": 8080
        },
        "host": {
          "type": "string",
          "default": "127.0.0.1"
        },
        "basePath": {
          "type": "string",
          "default": ""
        }
      }
    },
    "control": {
      "type": "object",
      "additionalProperties": false,
      "description": "The control surface. Must not be reachable from the mocked surface's routes.",
      "properties": {
        "prefix": {
          "type": "string",
          "pattern": "^/",
          "default": "/__understudy",
          "description": "Reserved prefix. A request here is never routed into the mocked surface. Composed as prefix + path, so it carries no trailing slash."
        },
        "port": {
          "type": "integer",
          "minimum": 0,
          "maximum": 65535,
          "description": "Omit to serve the control API on the same instance as the mock, under the prefix."
        },
        "host": {
          "type": "string"
        }
      }
    },
    "storage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "driver": {
          "type": "string",
          "enum": [
            "sqlite",
            "postgres"
          ],
          "default": "sqlite",
          "description": "Reserved for a later slice: only 'sqlite' is implemented. 'postgres' is accepted by the schema so the shape is stable before the feature lands; selecting it refuses to start with a clear message until the adapter exists."
        },
        "path": {
          "type": "string",
          "default": "./.understudy/state.db",
          "description": "SQLite file. Its directory is created if absent; an unwritable path refuses to start."
        }
      }
    },
    "ids": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "generatedStart": {
          "type": "integer",
          "default": 100000,
          "description": "First identity for records created over the API. Reserved range: it must not overlap identities that fixtures will declare in slice 2."
        }
      }
    },
    "signing": {
      "type": "object",
      "additionalProperties": false,
      "description": "RESERVED — accepted by the schema so the shape is stable, but not read in this slice, and selecting it is a STARTUP REFUSAL naming the key (it is never a silent no-op: a config key that quietly does nothing is worse than one that does not exist). Webhook HMAC signing lands with the webhook slices; algorithm, header name and signed-content template will all be configurable.",
      "properties": {
        "alg": {
          "type": "string",
          "default": "hmac-sha256"
        },
        "header": {
          "type": "string",
          "default": "X-Signature"
        }
      }
    },
    "clock": {
      "type": "object",
      "additionalProperties": false,
      "description": "RESERVED — accepted by the schema so the shape is stable, but not read in this slice, and selecting it is a STARTUP REFUSAL naming the key (it is never a silent no-op). A virtual clock (fast-forward for time-dependent scenarios) is a later slice; until then the tool uses the real clock and reports that it does.",
      "properties": {
        "mode": {
          "type": "string",
          "enum": [
            "real",
            "virtual"
          ],
          "default": "real"
        },
        "start": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  }
};
