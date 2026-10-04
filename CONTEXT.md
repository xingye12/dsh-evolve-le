# Ubiquitous language

## Trajectory Evidence Pack

An immutable, development-labelled, redacted and bounded projection of one
provider trial. It has ordered event IDs, verifier evidence and terminal facts.
It is evidence for diagnosis, not an instruction channel or a replacement for
the raw terminal artifact.

## Error Trigger

A claimed observable wrong commitment in one trajectory step, coupled with a
verbatim reference that it violates. A trigger without both verified anchors
is not a diagnosis.

## Error Instance

The lifecycle of one concrete violated object across one trajectory. Instances
group triggers by that object, never merely by a shared error label.

## Critical Failure

The trusted, deterministic projection of the earliest qualified Error Trigger
in an Error Instance with a verified terminal connection. It can be absent
when the evidence is insufficient or all instances were repaired/local.

## Trajectory Diagnosis

The content-addressed Agent Debugger result for one Trajectory Evidence Pack.
It is development evidence that a proposer may inspect; it has no authority
over reward, retry, selection, admission or promotion.
