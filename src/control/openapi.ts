/**
 * The control plane describes itself (T030, FR-018).
 *
 * The served document is the CHECKED-IN contract, byte for byte — never a description built
 * from the implementation, which could not disagree with the code and so would not be a
 * contract. `openapi.generated.ts` is the build-time inline copy of
 * `specs/001-slice-1-core/contracts/control-api.openapi.yaml`; a test compares the served
 * bytes with the checked-in file.
 */
import { controlApiDocument } from "./openapi.generated.js";

/** The exact bytes of the contract. */
export const controlApiBytes: string = controlApiDocument;

/** What the contract declares for `GET /openapi.json`, although the bytes are YAML text. */
export const CONTROL_API_CONTENT_TYPE = "application/json";
