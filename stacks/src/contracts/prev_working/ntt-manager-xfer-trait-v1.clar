;; This is for transferring the state of `ntt-manager` during updates
;; This does not cover `ntt-manager-state`, which cannot be updated
(define-trait transfer-trait (
  ;; Transfer state and funds of `ntt-manager` to caller
  ;; Fails if caller is not successor contract
  (transfer-state ()
    (response {
      pauser: principal,  ;; Account which can pause this contract
      next-sequence: uint ;; Sequence number of next message
    } uint))))