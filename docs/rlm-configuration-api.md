# RLM configuration API

This document defines the public configuration surface for `pi-turtle-rlm` in the current codebase.

## Scope

- package options (public extension configuration)
- Pi extension flags (root/session flags)
- runtime profile config files (JSON)
- `/rlm` command contract for profile management

## 1) Package-level API

`createRlmExtension` accepts the exported `RlmExtensionOptions` type.

### `RlmExtensionOptions`

| Property | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `maxDepth` | `number` | no | `2` | max recursion depth for child invocations |
| `profile` | `string` | no | `openai-5.4-class` (`DEFAULT_PROFILE_NAME`) | active execution profile name |
| `profiles` | `Record<string, RlmExecutionProfile>` | no | `{}` | inline profile overrides/definitions shipped at extension construction |
| `profileConfigPath` | `string` | no | unset | explicit override for where profile config reads/writes are targeted |
| `externalizationKernel` | `string` | no | `"current"` | disable child helper calls in no-subcalls mode (`current` or `no-subcalls`) |

`createRlmExtension()` defaults `maxDepth` to `2` and passes `depth: 0`, `root: true`, plus the supplied profile/config options through to the core installer.

This is the exported package construction entrypoint.

## 2) Pi extension flags

These flags are available once the extension is active:

- `rlm-enabled: boolean`  
  Default: `false`  
  Enables root RLM mode automatically on session start.

- `rlm-profile: string`  
  Default: `openai-5.4-class`  
  Sets the active profile name for session startup and validation.

- `rlm-externalization-kernel: string`  
  Default: `current`  
  Values: `current` | `no-subcalls`  
  In `no-subcalls`, runtime guidance and validation switch to no-subcall behavior.

## 3) `/rlm` command API (root mode only)

The root `/rlm` command supports:

- ` /rlm`  
  Toggle RLM mode on/off.
- `/rlm profile <name>`  
  Set active profile by name.
- `/rlm profile set <name>`  
  Set active profile by explicit `set` keyword.
- `/rlm profile list`  
  List known profiles.
- `/rlm profile add <name> <json>`  
  Add or replace a profile in resolved config.
- `/rlm profile clone <from> <to>`  
  Clone an existing resolved profile to `<to>`.
- `/rlm profile inspect [name]` (`show|inspect|info`)  
  Inspect active profile if no name is provided.
- `/rlm profile remove <name>`  
  Remove a profile from the first writable config source.
- `/rlm inspect`  
  Show runtime workspace state.
- `/rlm reset`  
  Clear runtime state.

Usage text shown on invalid input includes all of the above actions.

### Command side effects

- `add`, `clone`, and `remove` persist to:
  - explicit `profileConfigPath` when provided
  - otherwise default project config: `.pi/agent/rlm-config.json`
- add/clone/write always write JSON shaped as `RlmProfileConfigFile` with `version: 1`.

## 4) Profile file configuration API

Profile files are JSON with this envelope:

```json
{
  "version": 1,
  "profiles": {
    "example-profile": {
      "...": "..."
    }
  }
}
```

Alternative payload is also supported for migration compatibility as a bare profile map:

```json
{
  "example-profile": {
    "name": "example-profile",
    "behavior": {
      "guidanceVariant": "default"
    }
  }
}
```

### File resolution

Read resolution is:

1. global config: `~/.pi/agent/rlm-config.json`
2. project config: `<cwd>/.pi/agent/rlm-config.json`
3. explicit `profileConfigPath` (if provided)

If explicit path is missing/duplicate it is normalized and deduplicated.

Write resolution is:

- explicit `profileConfigPath` if provided
- otherwise `<cwd>/.pi/agent/rlm-config.json`

### File structure: `RlmExecutionProfile`

`RlmExecutionProfile` is the exported profile shape:

```ts
type RlmExecutionProfile = {
  name: string;
  description?: string;
  behavior: {
    guidanceVariant: "default" | "direct-tools-first" | "recursive-first";
    taskFewShotVariant?: "none" | "artifact-workflow-neutral-v1" | "artifact-workflow-openai-v1" | "artifact-workflow-local-v1";
    rootKickoffVariant?: "none" | "recursive-scout-v1" | "recursive-chain-v1";
    directToolBias?: "high" | "medium" | "low";
    runtimeBias?: "high" | "medium" | "low";
    recursiveBias?: "high" | "medium" | "low";
    shortestExecProgram?: boolean;
    avoidManualScanSubstitution?: boolean;
    simplifyAfterOptionalFailure?: boolean;
  };
  helpers?: {
    simpleChild?: {
      defaultModel?: `${string}/${string}` | `${string}/${string}:${"off" | "minimal" | "low" | "medium" | "high" | "xhigh"}`;
      thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      budget?: "low" | "medium" | "high";
    };
    recursiveChild?: {
      defaultModel?: `${string}/${string}` | `${string}/${string}:${"off" | "minimal" | "low" | "medium" | "high" | "xhigh"}`;
      inheritParentByDefault?: boolean;
      thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      budget?: "low" | "medium" | "high";
    };
  };
  fallback?: {
    onMissingSimpleChildModel?: "fail" | "warn-and-inherit" | "warn-and-disable";
    onMissingRecursiveChildModel?: "fail" | "warn-and-inherit" | "warn-and-disable";
  };
  promptOverrides?: {
    rootKickoff?: {
      current?: { root?: string; exec?: string };
      "no-subcalls"?: { root?: string; exec?: string };
    };
    taskFewShot?: {
      current?: { root?: string; exec?: string };
      "no-subcalls"?: { root?: string; exec?: string };
    };
    execPromptSnippet?: { current?: string; "no-subcalls"?: string };
    execCodeParamDescription?: { current?: string; "no-subcalls"?: string };
    legacyDenseExecGuidelineLines?: { current?: string[]; "no-subcalls"?: string[] };
  };
};
```

### Defaulting and normalization

- Unspecified `behavior` values are normalized:
  - `guidanceVariant` defaults to `"default"`
  - `taskFewShotVariant` defaults to `"none"`
  - `rootKickoffVariant` defaults to `"none"`
  - biases default to `"medium"`
  - booleans default to `true` where applicable (`shortestExecProgram`, `avoidManualScanSubstitution`, `simplifyAfterOptionalFailure`)
- Unspecified helper values become `undefined` and `recursiveChild.inheritParentByDefault` defaults to `false`.
- Fallback fields default to `"warn-and-inherit"`.
- Config object is schema-tolerant:
  - invalid strings and extra keys are normalized away rather than rejected during parse
  - hard errors are only thrown for invalid JSON or invalid model selector syntax where validated.

## 5) Profile resolution model

### Name resolution order (active profile)

For root session startup and restore, effective profile selection is:

1. Last saved session profile from branch state (`rlm-profile` custom branch entry), if present.
2. `rlm-profile` root flag, if present.
3. In-memory active option (`options.profile`) if provided.
4. Built-in `DEFAULT_PROFILE_NAME`.
5. Built-in fallback if an unknown profile is requested.

For non-root/child installs that do not read branch profile state, the starting profile is `options.profile ?? DEFAULT_PROFILE_NAME`.

### Merge order

For a single session:

1. built-in profiles from `rlm-profiles.json`
2. merged custom profiles from config files (global + project + explicit path; later entries override earlier)
3. inline `options.profiles` (highest precedence)

### Activation validation

Active profiles are validated on resolution:

- `profile.helpers.simpleChild.defaultModel` and `profile.helpers.recursiveChild.defaultModel` are parsed as model selectors.
- Both provider/id and selector syntax are validated (`provider/id[:thinking]`).
- Registry lookup and auth resolution are checked via model registry methods.

If validation fails, profile activation is rejected and reflected in user-visible error state.

## 6) Child model resolution precedence

When a child helper is invoked, model selection is resolved as:

1. explicit `model` in `llm_query`/`rlm_query` request
2. active profile default for the helper role
3. recursive helper only: parent model inheritance (if allowed by `recursiveChild.inheritParentByDefault`)
4. parent model (fallback)

If no usable model exists:

- `warn-and-inherit` (default): keep session model inheritance behavior.
- `warn-and-disable`: throw error for helper-specific use.
- `fail`: throw immediately for the active profile configuration issue.

## 7) Built-in profiles

Built-ins come from `rlm-profiles.json` and are normalized with the above rules.

Default built-in:
- `openai-5.4-class`

Also available:
- `inherit-parent-class`
- `mlx-qwopus-class`
- `mlx-qwopus-legacy-dense`

## 8) Model selector syntax reference

Model selectors used in profile defaults or explicit model overrides:

- `${provider}/${id}` or `${provider}/${id}:${thinking}`
- valid thinking values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- invalid syntax is rejected with validation error before runtime helper use.

## 9) Suggested configuration examples

### Minimal profile file

```json
{
  "version": 1,
  "profiles": {
    "my-profile": {
      "name": "my-profile",
      "behavior": {
        "guidanceVariant": "default"
      },
      "helpers": {
        "simpleChild": {
          "defaultModel": "openai-codex/gpt-5.4-mini:off"
        }
      },
      "fallback": {
        "onMissingSimpleChildModel": "warn-and-inherit",
        "onMissingRecursiveChildModel": "warn-and-inherit"
      }
    }
  }
}
```

### Full example with recursive overrides

```json
{
  "version": 1,
  "profiles": {
    "my-strong-recursion": {
      "name": "my-strong-recursion",
      "description": "Use helpers aggressively for recursive work",
      "behavior": {
        "guidanceVariant": "recursive-first",
        "directToolBias": "medium",
        "runtimeBias": "high",
        "recursiveBias": "high",
        "rootKickoffVariant": "recursive-chain-v1",
        "taskFewShotVariant": "artifact-workflow-neutral-v1",
        "shortestExecProgram": true
      },
      "helpers": {
        "simpleChild": {
          "defaultModel": "openai-codex/gpt-5.4-mini:off",
          "thinking": "off",
          "budget": "low"
        },
        "recursiveChild": {
          "defaultModel": "openai-codex/gpt-5.4:medium",
          "inheritParentByDefault": true,
          "thinking": "low",
          "budget": "medium"
        }
      },
      "fallback": {
        "onMissingSimpleChildModel": "warn-and-inherit",
        "onMissingRecursiveChildModel": "warn-and-disable"
      },
      "promptOverrides": {
        "execPromptSnippet": {
          "current": "Use runtime + durable workspace and keep helper usage constrained."
        }
      }
    }
  }
}
```

## 10) Versioning and migration notes

- Configuration payload supports `version: 1` (written by extension write paths).
- Parser currently reads wrapped and unwrapped profile maps; unknown keys are ignored through normalization.
- For stricter API evolution in the future, bumping `version` is the place to add backward-compatible migrations.
