/**
 * Document loading (FR-001, FR-022).
 *
 * Reads the document from a path or a URL, resolves external `$ref`s, upconverts
 * 3.0 → 3.1 so everything downstream sees one dialect, dereferences internal refs,
 * and extracts the declared version plus a content hash.
 *
 * The only outbound network call is fetching a URL the user supplied: the URL
 * fetcher plugin is only wired in when the source is itself a URL, so a file spec
 * with a URL `$ref` is never silently fetched.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundle } from "@scalar/json-magic/bundle";
import {
  fetchUrls,
  parseJson,
  parseYaml as parseYamlPlugin,
  readFiles,
} from "@scalar/json-magic/bundle/plugins/node";
import { dereference } from "@scalar/openapi-parser";
import { upgrade } from "@scalar/openapi-upgrader";
import { parse as parseYaml } from "yaml";
import { SpecInvalidError, SpecUnreadableError } from "../errors.js";
import type { LoadedSpec } from "./types.js";

export type { LoadedSpec } from "./types.js";

const URL_LIKE = /^https?:\/\//i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function declaredVersion(document: Record<string, unknown>): string | undefined {
  if (typeof document.openapi === "string") return document.openapi;
  if (typeof document.swagger === "string") return document.swagger;
  return undefined;
}

export function isUrlSource(source: string): boolean {
  return URL_LIKE.test(source);
}

export async function loadSpec(source: string): Promise<LoadedSpec> {
  const isUrl = isUrlSource(source);
  const origin = isUrl ? source : resolve(source);

  let rawText: string;
  if (isUrl) {
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      rawText = await response.text();
    } catch (error) {
      throw new SpecUnreadableError(source, messageOf(error));
    }
  } else {
    try {
      rawText = readFileSync(origin, "utf8");
    } catch (error) {
      throw new SpecUnreadableError(source, messageOf(error));
    }
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (error) {
    throw new SpecInvalidError(source, `not valid YAML or JSON: ${messageOf(error)}`);
  }
  if (!isObject(parsed)) {
    throw new SpecInvalidError(source, "the document is not an object");
  }
  const sourceVersion = declaredVersion(parsed);
  if (!sourceVersion) {
    throw new SpecInvalidError(source, "the document declares no openapi/swagger version");
  }

  let bundled: object;
  try {
    const plugins = isUrl
      ? [fetchUrls(), parseYamlPlugin(), parseJson()]
      : [readFiles(), parseYamlPlugin(), parseJson()];
    bundled = await bundle(parsed, { plugins, origin, treeShake: false });
  } catch (error) {
    throw new SpecUnreadableError(source, `a referenced document could not be resolved: ${messageOf(error)}`);
  }

  let upgraded: Record<string, unknown>;
  try {
    upgraded = upgrade(bundled as Record<string, unknown>, "3.1") as unknown as Record<string, unknown>;
  } catch (error) {
    throw new SpecInvalidError(source, `could not be normalised to OpenAPI 3.1: ${messageOf(error)}`);
  }

  let result: Awaited<ReturnType<typeof dereference>>;
  try {
    result = await dereference(upgraded);
  } catch (error) {
    throw new SpecInvalidError(source, `could not be dereferenced: ${messageOf(error)}`);
  }
  const firstError = result.errors?.[0];
  if (firstError) {
    throw new SpecInvalidError(source, `an unresolved $ref: ${firstError.message}`);
  }
  if (!result.schema) {
    throw new SpecInvalidError(source, "the document produced no usable schema");
  }

  const document = result.schema as Record<string, unknown>;
  // `bundle` parks external documents under `x-ext`; after dereferencing it is dead weight.
  delete document["x-ext"];

  const version = typeof document.openapi === "string" ? document.openapi : "3.1";
  const contentHash = createHash("sha256").update(rawText).digest("hex");

  return { source, isUrl, version, sourceVersion, contentHash, document };
}