# Controlled candidate lifecycle events

Native `dsh-evolve-le/native-dsh/v3` emits 20 controlled events. The implementation
and policy are in `packages/dsh-evolve-le/src/dsh/candidate-events.ts` (ADR-076).
The upstream event contracts come from the pinned agent, tools and session source;
this table describes the smaller candidate projection.

| Register in     | Event names                                                                                                                                            | Timing / facts                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `agentEvents`   | `candidate:agent/pre-step`                                                                                                                             | Existing admitted-step v1 context                                                                               |
| `agentEvents`   | `candidate:agent/request`, `candidate:agent/request-error`                                                                                             | Before request / before upstream failure policy; coordinates only                                               |
| `agentEvents`   | `candidate:agent/error`, `candidate:agent/status`, `candidate:agent/turn-stopping`                                                                     | Loop failure, idle/running transition, turn closure boundary                                                    |
| `agentEvents`   | `candidate:agent/tool-pre-execute`                                                                                                                     | Before tool gate; coarse kind and pending outcome                                                               |
| `agentEvents`   | `candidate:agent/tool-post-execute`                                                                                                                    | Before result middleware; coarse dispatch outcome                                                               |
| `agentEvents`   | `candidate:agent/tool-result`                                                                                                                          | Final tool settlement; coarse final outcome                                                                     |
| `sessionEvents` | `candidate:session/start`, `candidate:session/end`                                                                                                     | Existing v1 lifecycle callbacks; end outputs do not steer a closed session                                      |
| `sessionEvents` | `candidate:session/event`                                                                                                                              | Type-only notification for user/assistant message, tool call/result, turn/step boundaries and compaction events |
| `sessionEvents` | `candidate:session/turn-start`, `candidate:session/turn-end`                                                                                           | Durable turn boundary; end includes coarse stop reason                                                          |
| `sessionEvents` | `candidate:session/step-start`, `candidate:session/step-end`                                                                                           | Durable step boundary                                                                                           |
| `sessionEvents` | `candidate:session/compaction-start`, `candidate:session/compaction-summary`, `candidate:session/compaction-end`, `candidate:session/compaction-prune` | Compression lifecycle; no summary body or discarded content                                                     |

Expanded callbacks receive `protocol: dsh-evolve-le/candidate-strategy-context/v2`,
`phase: event`, coordinates, the existing coarse observation and an `event` object.
Fields appear only when applicable: `name`, `toolKind` (exec/read/write/finish/
delegate/candidate), `outcome` (pending/succeeded/failed), `status`,
`sessionEventType`, `stopReason`. Unknown outcomes/statuses/reasons are projected
as unknown where appropriate. Proposal observation does not invent solve-tool
history; its tool events provide the coarse proposal tool kind/outcome.

```ts
import { defineCandidate, type CandidateStrategyContext } from '@dsh-evolve-le/candidate-sdk'

const candidate = defineCandidate({
  solve: {
    agentEvents: () => [
      {
        name: 'candidate:agent/tool-result',
        handler: (value) => {
          const context = value as CandidateStrategyContext
          if (context.event?.outcome === 'failed') {
            return { checkpoint: 'Check the failed action before repeating it.' }
          }
        },
      },
    ],
  },
  propose: {},
})
```

For tree-v2, declare `agent-events` capability and the exact tool event name in
that mode's `agentEventNames`. Session hooks use `session-events` and
`sessionEventNames`. Install `candidate.register()` from `candidateStrategySetup`
in each native agent scope, as the baseline does. Root Loader declarations alone
are admission inventory; they do not install per-agent callbacks.

Callbacks can return a checkpoint of at most 2,048 characters. Expanded callbacks
queue it for the next admitted pre-step, including a later turn if the current
turn has finished. They cannot call `next`, modify results, choose a new route,
retry a request, change TCB stopping decisions or receive raw tool/message/error
content. There are at most 256 pending notifications and 64 queued checkpoints;
overflow or handler failure fails closed. Empty/invalid checkpoint values are
ignored. Session-end outputs are audit-only.

Solve, proposal and child agents use independent registries. Children get the
same mechanism; another session's durable events are filtered. Callback audits
are retained as `candidateEvents` in solve ACP native-evidence metadata, proposal
transcripts and child records; original DSH session events remain unchanged.
New native semantics require a fresh run identity and baseline calibration.
