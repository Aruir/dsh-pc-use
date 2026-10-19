// r26: the computer-use skill Codex ships in its own installation, read at runtime and offered
// to DSH's skill registry. The body is never copied into this repository: list/get read the
// SKILL.md under <codexHome>/plugins/cache/openai-bundled/computer-use/<version>/skills/
// computer-use/ on every call, and the DSH notes are appended when a definition is loaded.

import { readFileSync, statSync } from 'node:fs'

import { resolveComputerUseDocs } from './codex-config.js'

/** DSH skill name; the native `computer-use:computer-use` is not kebab-case. */
export const SKILL_NAME = 'codex-computer-use'

/** Largest SKILL.md this plugin reads; anything bigger is not a skill file it understands. */
const MAX_SKILL_BYTES = 64 * 1024

/** Longest accepted frontmatter description. */
const MAX_DESCRIPTION_LENGTH = 1024

/**
 * DSH notes appended to a loaded skill body. Kept here as one literal so the text is exact.
 * O(1).
 */
export const SKILL_DSH_NOTES = 'DSH notes. In DSH, the desktop `node_repl` tools are exposed as '
  + '`pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and '
  + '`pc_codex_desktop_js_add_node_module_dir`. The documents this skill names under `docs/` can '
  + 'be read with `pc_codex_docs`: `docs/guidance.md` is topic `guidance`, `docs/api.md` is topic '
  + '`api`, and `docs/confirmations.md` is topic `confirmations`. Desktop control needs the '
  + "plugin's `computer` setting to be on."

/** Remove one pair of matching surrounding quotes, if present. O(1). */
function unquote(value) {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1)
  return value
}

/**
 * Parse one SKILL.md text. The file must start with a `---` line and close the frontmatter on
 * the next `---` line; CRLF and LF line endings are both accepted. Frontmatter is read line by
 * line as `key: value` (unrecognised lines are ignored, multi-line values are not supported),
 * values are trimmed and one pair of surrounding quotes is removed. Returns `{ description,
 * body }` with the body's CRLF normalised to LF and trimmed, or `null` when the frontmatter, a
 * non-empty description of at most 1024 characters, or a body is missing. O(file size).
 */
export function parseSkillFile(raw) {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) return null
  const frontmatter = new Map()
  for (const line of lines.slice(1, closing)) {
    const match = /^\s*([^:\s][^:]*):\s?(.*)$/.exec(line)
    if (match === null) continue
    frontmatter.set(match[1].trim(), unquote(match[2].trim()))
  }
  const description = frontmatter.get('description')
  if (typeof description !== 'string' || description === '') return null
  if (description.length > MAX_DESCRIPTION_LENGTH) return null
  const body = lines.slice(closing + 1).join('\n').trim()
  if (body === '') return null
  return { description, body }
}

/**
 * Read and parse the skill from a Codex home. `resolveComputerUseDocs` picks the version
 * directory (`preferVersion` when that version exists, else the newest) and the `skill` file
 * inside it. Any failure (unresolvable docs, missing file, non-file, larger than 64 KiB,
 * unparsable text) returns `null`. The file is read again on every call; nothing is cached.
 * O(file size).
 */
export function readCodexSkill({ codexHome, preferVersion = null } = {}) {
  let resolved
  try {
    resolved = resolveComputerUseDocs({ codexHome, preferVersion })
  } catch {
    return null
  }
  const file = resolved.files.skill
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const parsed = parseSkillFile(raw)
  if (parsed === null) return null
  return {
    description: parsed.description,
    body: parsed.body,
    file,
    versionDir: resolved.dir,
    version: resolved.version,
  }
}
