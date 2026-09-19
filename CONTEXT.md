# DiffOwl

DiffOwl captures local code-review evidence and turns successful model output into durable findings.

## Language

**Review operation**:
One immutable review input and local-context manifest shared by every reviewer assigned to the work.
_Avoid_: Run, review run, session

**Review execution**:
One reviewer's bounded attempt within a review operation, including attempts that complete, fail, time out, or are cancelled.
_Avoid_: Session, operation

**Review**:
A successfully produced structured review document whose findings can enter durable finding reconciliation.
_Avoid_: Attempt, execution, operation

**Finding**:
A durable code concern that can be observed across reviews and move through the finding lifecycle.

**Review readiness**:
A derived proof that an exact committed branch snapshot has compatible complete
review coverage and no unhandled blocking findings.
_Avoid_: Approval, permission to merge

**Coverage checkpoint**:
A complete branch review from which compatible review coverage can be traced.
_Avoid_: Latest review

**Review lineage**:
A connected sequence of compatible review evidence for a branch's committed
changes under one resolved base and review policy.
_Avoid_: Session history
_Avoid_: Claim, comment, issue
