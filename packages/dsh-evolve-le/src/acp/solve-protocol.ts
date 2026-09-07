/**
 * Solve directive protocol (ADR-030): the strict JSON grammar the live-solve
 * model speaks. One directive per model turn; tool effects flow back as
 * rendered tool-result blocks appended to the next turn's user text. Kept
 * deliberately separate from `proposer/policy.ts` — the proposer's directive
 * surface is a frozen policy input and must not grow solver concerns.
 *
 * Grammar (all fields required unless noted):
 *
 * ```json
 * {"op":"exec","command":"make test && ./run"}   — bare string = shell command
 * {"op":"exec","command":"sh","args":["-lc","make test"]} — program + argv, no shell
 * {"op":"exec","command":["sh","-lc","make test"]} — array form = program + argv
 * {"op":"read","path":"/app/notes.txt"}
 * {"op":"write","path":"/app/solution.py","content":"print(1)\n"}
 * {"op":"final","answer":"The ELF is little-endian."}
 * ```
 *
 * All three exec spellings normalize at parse time: a bare (or empty-argv)
 * string command wraps as `/bin/sh -c <command>` — the paid smoke watched the
 * model reach for `pwd && which R` as a plain string and for the argv-array
 * habit, and a direct spawn of such strings dies server-side; an explicit
 * non-empty argv spawns the named program without a shell.
 *
 * A parse failure is a RECOVERABLE turn — the error is fed back to the model
 * as the next tool result and the loop continues, bounded by the turn cap.
 * A hard protocol breach never happens silently: the trajectory records
 * every raw model chunk (harbor persists `agent_message_chunk`), so an
 * off-grammar model is auditable post-hoc.
 * @module @dsh-evolve-le/core/acp/solve-protocol
 */

export type SolveDirective =
  | { op: 'exec'; command: string; args?: string[] }
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'final'; answer: string }

export class SolveProtocolError extends Error {
  constructor(message: string) {
    super(`solve-protocol: ${message}`)
    this.name = 'SolveProtocolError'
  }
}

/**
 * Parse one model turn into a directive.
 *
 * The model is chatty (K=10 attempt 2): one completion can carry reasoning,
 * the directive, HALLUCINATED tool results, and further directives — it
 * simulates the whole multi-turn loop in a single turn. So this never assumes
 * "one JSON object is the whole text": it scans from the first `{` for the
 * FIRST balanced JSON object (string/escape aware), validates exactly that
 * object as the directive, and ignores every later byte. If the first object
 * is malformed or not a directive, the turn fails recoverably instead of
 * executing a later object from the model's hallucinated transcript.
 *
 * Accepts a ```json-fenced block wrapping the object as well; anything else
 * is a recoverable {@link SolveProtocolError}.
 */
export function parseSolveDirective(text: string): SolveDirective {
  const stripped = stripFences(text)
  const candidate = firstBalancedObject(stripped)
  if (candidate === null) {
    throw new SolveProtocolError('no JSON object in the model turn')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    throw new SolveProtocolError(`unparseable JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SolveProtocolError('directive is not an object')
  }
  return directiveOf(parsed as Record<string, unknown>)
}

/** The record-to-directive switch, factored out so candidates can share it. */
function directiveOf(record: Record<string, unknown>): SolveDirective {
  switch (record['op']) {
    case 'exec': {
      const command = record['command']
      const args = record['args']
      // Normalize to (program, argv): a directive that names no argv — a bare
      // string, a string paired with "args":[], or a one-element command
      // array — is a SHELL command, because a direct spawn of "pwd && which R"
      // dies server-side ("Resource not found"), the exact waste the paid
      // smoke watched the model burn turns on. An explicit argv (non-empty
      // args, or a ≥2-element array) spawns the named program without a
      // shell, preserving the ambient environment.
      const shellForm = (shellCommand: string): SolveDirective => ({
        op: 'exec',
        command: '/bin/sh',
        args: ['-c', shellCommand],
      })
      if (Array.isArray(command)) {
        if (
          command.length === 0 ||
          command.some((part) => typeof part !== 'string' || part.length === 0)
        ) {
          throw new SolveProtocolError('exec command array must be non-empty strings')
        }
        if (args !== undefined) {
          throw new SolveProtocolError(
            'exec: pass args alongside a string command, not alongside a command array',
          )
        }
        if (command.length === 1) return shellForm(command[0] as string)
        const [program, ...programArgs] = command
        return { op: 'exec', command: program, args: programArgs }
      }
      if (typeof command !== 'string' || command.length === 0) {
        throw new SolveProtocolError('exec requires a non-empty command string')
      }
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      ) {
        throw new SolveProtocolError('exec args must be an array of strings')
      }
      if (args === undefined || args.length === 0) return shellForm(command)
      return { op: 'exec', command, args }
    }
    case 'read': {
      const path = record['path']
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new SolveProtocolError('read requires an absolute path')
      }
      return { op: 'read', path }
    }
    case 'write': {
      const path = record['path']
      const content = record['content']
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new SolveProtocolError('write requires an absolute path')
      }
      if (typeof content !== 'string') {
        throw new SolveProtocolError('write requires a string content')
      }
      return { op: 'write', path, content }
    }
    case 'final': {
      const answer = record['answer']
      if (typeof answer !== 'string') {
        throw new SolveProtocolError('final requires a string answer')
      }
      return { op: 'final', answer }
    }
    default:
      throw new SolveProtocolError(`unknown op ${String(record['op'])}`)
  }
}

/** Strip leading/trailing markdown fences the model may wrap the JSON in. */
function stripFences(text: string): string {
  const match = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text.trim())
  return match !== null ? (match[1] ?? '') : text
}

/**
 * The first substring of `text` that starts at the first `{` and closes at its
 * balanced `}`. String bodies and escapes do not affect brace depth. A first
 * object that never closes is a streaming cutoff; later `{` bytes are part of
 * that broken object and are never considered as a fallback directive.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/**
 * The protocol section appended to the composed system sections for every
 * live solve turn. Frozen text: it is part of the prompt hash, so a change
 * here changes every recorded prompt hash and must never happen mid-run.
 */
export const SOLVE_PROTOCOL_SECTION = {
  name: 'tcb:solve-protocol',
  order: 9_999,
  text: [
    'You are solving a Terminal-Bench task inside a container workspace.',
    'Reply with EXACTLY ONE JSON object per turn and nothing else:',
    '{"op":"exec","command":"<shell command>"} — run a shell command in the workspace (cwd is the workspace root; pipes, &&, || and ; all work).',
    '{"op":"exec","command":"<program>","args":["<arg>",...]} — spawn one program with an argument list (no shell).',
    '{"op":"exec","command":["<program>","<arg>",...]} — the same, as a single array.',
    '{"op":"read","path":"<absolute path>"} — read a text file.',
    '{"op":"write","path":"<absolute path>","content":"<full file content>"} — write a text file (whole content).',
    '{"op":"final","answer":"<final answer for the task>"} — the task is complete; give the answer the verifier expects.',
    'After each turn you receive the tool result. Work step by step; verify your work with exec before answering. When the task asks for a file or repository state, write the files rather than describing them.',
  ].join('\n'),
} as const

/**
 * Hard caps for the capsule's live-solve loop (ADR-030): they bound a runaway
 * trial that spends wall clock without spending tokens (free tool loops).
 * Token/cost/request caps are enforced by the gateway, not the agent — the
 * agent's figures are advisory cross-checks; receipts are the authority.
 * Lives in this zero-import module because `acp-boot` ships inside the
 * capsule and must not pull the config/schema/ajv graph with it.
 */
export const SOLVE_AGENT_LIMITS = {
  /** Model turns per trial (directive execution is bounded by this). */
  maxTurns: 40,
  /** One exec directive's wall clock before kill(). */
  commandTimeoutMs: 300_000,
  /** Never let one model request run past the live gateway's 10 minute cap. */
  requestTimeoutMs: 660_000,
} as const

/** Non-secret, per-job effective Harbor agent ceiling supplied by the adapter. */
export const SOLVE_AGENT_TIMEOUT_ENV = 'DSH_SOLVE_AGENT_TIMEOUT_MS'

/** Measured ACP/Harbor shutdown allowance after the capsule returns. */
export const SOLVE_HARBOR_TEARDOWN_RESERVE_MS = 300_000

/** Runtime limits after deriving the task-specific capsule deadline. */
export interface LiveSolveRuntimeLimits {
  maxTurns: number
  commandTimeoutMs: number
  requestTimeoutMs: number
  wallClockMs: number
}

/**
 * The adapter passes Harbor's actual `task timeout_sec × multiplier` ceiling.
 * The capsule ends five minutes earlier so its final usage update, runner
 * summary and container teardown finish before Harbor's hard kill.
 */
export function liveSolveLimitsFromAgentTimeout(
  rawEffectiveAgentTimeoutMs: string | undefined,
): LiveSolveRuntimeLimits {
  if (
    rawEffectiveAgentTimeoutMs === undefined ||
    !/^[1-9][0-9]*$/.test(rawEffectiveAgentTimeoutMs)
  ) {
    throw new Error(
      `solve-protocol: ${SOLVE_AGENT_TIMEOUT_ENV} must be a positive integer millisecond value`,
    )
  }
  const effectiveAgentTimeoutMs = Number(rawEffectiveAgentTimeoutMs)
  if (!Number.isSafeInteger(effectiveAgentTimeoutMs)) {
    throw new Error(`solve-protocol: ${SOLVE_AGENT_TIMEOUT_ENV} is outside the safe integer range`)
  }
  const wallClockMs = effectiveAgentTimeoutMs - SOLVE_HARBOR_TEARDOWN_RESERVE_MS
  if (wallClockMs <= 0) {
    throw new Error(
      `solve-protocol: ${SOLVE_AGENT_TIMEOUT_ENV} must exceed the ${String(SOLVE_HARBOR_TEARDOWN_RESERVE_MS)}ms teardown reserve`,
    )
  }
  return { ...SOLVE_AGENT_LIMITS, wallClockMs }
}
