// The host validates every tool's `parameters` against one DSL before the tool
// exists. An object parameter without `additionalProperties`, or a stray key,
// throws at registration time — and because registration happens inside the
// plugin's `apply`, one bad parameter takes the whole plugin down and every
// `cu_*` tool disappears with no user-visible error.
//
// This file mirrors those rules so a mistake fails `npm test` instead of a DSH
// restart. Rules taken from @deepseek-ai/dsh-cordis-host-runner/guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";

const SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
  "json",
]);
const ANNOTATIONS = ["description", "title", "default", "examples"];

const isPlainRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assertKeys(value, path, allowed) {
  for (const key of Object.keys(value)) {
    assert.ok(
      allowed.includes(key),
      `${path}.${key} is not supported by the host parameter DSL (allowed: ${allowed.join(", ")})`
    );
  }
}

function assertParameterNode(value, path, { parameterProperty, raw, requiredNames }) {
  assert.ok(isPlainRecord(value), `${path} must be a parameter schema object`);
  const requiredKey = parameterProperty && !raw ? ["required"] : [];
  if (parameterProperty && raw && Object.hasOwn(value, "required") && value.type !== "object") {
    assert.fail(`${path}.required belongs to the containing raw object schema`);
  }
  if (parameterProperty && !raw && Object.hasOwn(value, "required")) {
    assert.equal(value.required, true, `${path}.required must be true when present`);
  }

  if (Object.hasOwn(value, "oneOf")) {
    assertKeys(value, path, ["oneOf", ...requiredKey, ...ANNOTATIONS]);
    assert.ok(Array.isArray(value.oneOf) && value.oneOf.length >= 2, `${path}.oneOf needs 2+ schemas`);
    value.oneOf.forEach((entry, index) =>
      assertParameterNode(entry, `${path}.oneOf[${index}]`, {
        parameterProperty: false,
        raw,
        requiredNames: new Set(),
      })
    );
    return;
  }

  if (raw && !Object.hasOwn(value, "type")) {
    assertKeys(value, path, ANNOTATIONS);
    return;
  }

  assert.ok(
    SCHEMA_TYPES.has(value.type),
    `${path} must declare a valid type (got ${JSON.stringify(value.type)})`
  );

  switch (value.type) {
    case "object": {
      assertKeys(value, path, [
        "type",
        "properties",
        "additionalProperties",
        ...requiredKey,
        ...(raw ? ["required"] : []),
        ...ANNOTATIONS,
      ]);
      if (!raw) {
        assert.ok(
          Object.hasOwn(value, "additionalProperties") &&
            typeof value.additionalProperties === "boolean",
          `${path}.additionalProperties must be explicitly true or false`
        );
      } else if (Object.hasOwn(value, "additionalProperties")) {
        assert.equal(
          typeof value.additionalProperties,
          "boolean",
          `${path}.additionalProperties must be a boolean`
        );
      }
      if (Object.hasOwn(value, "properties")) {
        assert.ok(isPlainRecord(value.properties), `${path}.properties must be an object of schemas`);
        for (const [name, schema] of Object.entries(value.properties)) {
          assertParameterNode(schema, `${path}.properties.${name}`, {
            parameterProperty: true,
            raw,
            requiredNames: new Set(),
          });
        }
      }
      return;
    }
    case "array": {
      assertKeys(value, path, ["type", "items", ...requiredKey, ...ANNOTATIONS]);
      if (Object.hasOwn(value, "items")) {
        assertParameterNode(value.items, `${path}.items`, {
          parameterProperty: false,
          raw,
          requiredNames: new Set(),
        });
      }
      return;
    }
    case "json":
      assertKeys(value, path, ["type", ...requiredKey, ...ANNOTATIONS]);
      return;
    default: {
      assertKeys(value, path, ["type", "enum", "const", ...requiredKey, ...ANNOTATIONS]);
      if (Object.hasOwn(value, "enum")) {
        assert.ok(Array.isArray(value.enum) && value.enum.length > 0, `${path}.enum must be non-empty`);
      }
      return;
    }
  }
}

export function assertHostParameterSchema(parameters, label = "parameters") {
  if (!isPlainRecord(parameters)) assert.fail(`${label} must be an object`);
  if (parameters.type === "object") {
    assertKeys(parameters, label, [
      "type",
      "properties",
      "required",
      "additionalProperties",
      ...ANNOTATIONS,
    ]);
    assert.ok(isPlainRecord(parameters.properties), `${label}.properties must be an object of schemas`);
    if (Object.hasOwn(parameters, "additionalProperties")) {
      assert.equal(parameters.additionalProperties, true, `${label}.additionalProperties must be true`);
    }
    for (const [name, schema] of Object.entries(parameters.properties)) {
      assertParameterNode(schema, `${label}.properties.${name}`, {
        parameterProperty: true,
        raw: true,
        requiredNames: new Set(),
      });
    }
    return;
  }
  for (const [name, schema] of Object.entries(parameters)) {
    assertParameterNode(schema, `${label}.${name}`, {
      parameterProperty: true,
      raw: false,
      requiredNames: new Set(),
    });
  }
}

function collectTools() {
  const tools = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    get: () => undefined,
  };
  registerCuTools({ ctx, manager: new CuSessionManager(), config: { autoSession: false } });
  return tools;
}

test("every cu_* tool declares a parameter schema the host will accept", () => {
  const tools = collectTools();
  assert.ok(tools.length >= 13, `expected the full tool set, got ${tools.length}`);
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string", "a tool needs a name");
    assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
    assertHostParameterSchema(tool.parameters, `${tool.name}.parameters`);
  }
});

test("object parameters carry an explicit openness contract", () => {
  // Regression: `expect` was declared as a bare `{type: "object"}` and took the
  // whole plugin down at load time.
  const tools = collectTools();
  const expectish = tools.filter((tool) => (tool.parameters.properties ?? tool.parameters).expect);
  assert.ok(expectish.length >= 3, JSON.stringify(tools.map((tool) => tool.name)));
  for (const tool of expectish) {
    const spec = (tool.parameters.properties ?? tool.parameters).expect;
    assert.equal(spec.type, "object");
    assert.equal(typeof spec.additionalProperties, "boolean", `${tool.name}.expect`);
    assert.ok(isPlainRecord(spec.properties), `${tool.name}.expect.properties`);
  }
});

test("the validator rejects the exact mistake that broke the plugin", () => {
  assert.throws(
    () => assertHostParameterSchema({ expect: { type: "object", description: "no openness" } }),
    /additionalProperties must be explicitly true or false/
  );
  assert.throws(
    () => assertHostParameterSchema({ ref: { type: "string", required: false, description: "x" } }),
    /required must be true when present/
  );
  assert.throws(
    () => assertHostParameterSchema({ steps: { type: "array", items: { type: "object" } } }),
    /additionalProperties/
  );
});
