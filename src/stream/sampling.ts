/**
 * Vendored from `@earendil-works/pi-ai` (upstream v0.86.0):
 * - `api/constrained-sampling` → `makeStrictJsonSchema`,
 *   `getJsonSchemaToolParameters`, `resolveJsonSchemaStrictSampling`
 * - `api/google-shared` → `requiresToolCallId`
 *
 * Why vendored instead of imported: the compiled `pi` binary only virtualizes
 * the `@earendil-works/pi-ai` root, `/compat`, `/oauth` and `/providers/*`
 * entrypoints for extensions. Deep subpath imports (`/api/*`, `/utils/*`) do
 * not resolve at extension load time and crash pi startup with
 * "Cannot find module '@earendil-works/pi-ai/api/...'".
 * These helpers are small, pure and dependency-free, so they live here.
 * Do NOT reintroduce `@earendil-works/pi-ai/api/*` imports.
 */
import type { Tool } from "@earendil-works/pi-ai";

type Schema = Record<string, unknown>;

class UnsupportedStrictJsonSchemaError extends Error {}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
];

function isJsonSchemaObject(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	const types =
		typeof schema.type === "string"
			? [schema.type]
			: Array.isArray(schema.type)
				? (schema.type as unknown[])
				: [];
	return (
		types.includes("object") ||
		types.includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	if (
		schema.type === "null" ||
		(Array.isArray(schema.type) && (schema.type as unknown[]).includes("null"))
	)
		return true;
	if (
		schema.const === null ||
		(Array.isArray(schema.enum) && (schema.enum as unknown[]).includes(null))
	)
		return true;
	return (
		Array.isArray(schema.anyOf) &&
		(schema.anyOf as unknown[]).some((variant) => schemaAllowsNull(variant))
	);
}

function makeJsonSchemaNodeStrict(schema: Schema): void {
	if (!isJsonSchemaObject(schema)) {
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) {
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || (schema.anyOf as unknown[]).length === 0) {
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		for (const variant of schema.anyOf as unknown[]) {
			if (isStructuredSchema(variant)) {
				throw new UnsupportedStrictJsonSchemaError(
					"object and array unions are unsupported",
				);
			}
			makeJsonSchemaNodeStrict(variant as Schema);
		}
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) {
			throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		}
		makeJsonSchemaNodeStrict(schema.items as Schema);
	}
	const isObjectSchema = schema.type === "object";
	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	if (!isObjectSchema) return;
	if (
		schema.additionalProperties !== undefined &&
		schema.additionalProperties !== false
	) {
		throw new UnsupportedStrictJsonSchemaError(
			"schema-valued or true additionalProperties is unsupported",
		);
	}
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) ||
			(schema.required as unknown[]).some((key) => typeof key !== "string"))
	) {
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}
	const properties = (schema.properties as Schema | undefined) ?? {};
	const propertyNames = Object.keys(properties);
	const required = new Set(
		Array.isArray(schema.required) ? (schema.required as string[]) : [],
	);
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property as Schema);
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	schema.required = propertyNames;
	schema.additionalProperties = false;
}

/** Convert a tool schema to the strict subset expected by provider constrained sampling. */
export function makeStrictJsonSchema(schema: Tool["parameters"]): Record<string, unknown> {
	const cloned = structuredClone(schema);
	if (!isJsonSchemaObject(cloned)) {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	makeJsonSchemaNodeStrict(cloned);
	if (cloned.type !== "object") {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	return cloned;
}

export function getJsonSchemaToolParameters(
	tool: Tool,
	strict: boolean | undefined,
): Tool["parameters"] {
	return (
		strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters
	) as Tool["parameters"];
}

export function resolveJsonSchemaStrictSampling(
	tool: Tool,
	supportsStrictMode: boolean,
): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;
	if (supportsStrictMode) {
		try {
			makeStrictJsonSchema(tool.parameters);
			return true;
		} catch (error) {
			if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
			if (config.strict !== "require") return undefined;
			throw new Error(
				`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`,
			);
		}
	}
	if (config.strict === "require") {
		throw new Error(
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
	return undefined;
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}
