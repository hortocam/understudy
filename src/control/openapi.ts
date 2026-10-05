/**
 * The control plane describes itself (T030, FR-018).
 *
 * The served document is the CHECKED-IN contract, byte for byte — never a description built
 * from the implementation, which could not disagree with the code and so would not be a
 * contract. `openapi.generated.ts` is the build-time inline copy of
 * `specs/001-slice-1-core/contracts/control-api.openapi.json`; a test compares the served
 * bytes with the checked-in file.
 */
import { controlApiDocument } from "./openapi.generated.js";

/** The exact bytes of the contract (genuine JSON, so the declared type below is truthful). */
export const controlApiBytes: string = controlApiDocument;

/** What the contract declares for `GET /openapi.json`; the bytes really are JSON. */
export const CONTROL_API_CONTENT_TYPE = "application/json";
