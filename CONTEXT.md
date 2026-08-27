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
_Avoid_: Claim, comment, issue
