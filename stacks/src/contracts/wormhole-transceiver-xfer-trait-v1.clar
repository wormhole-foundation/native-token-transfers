;; This is for transferring the state of `wormhole-transceiver` during updates
;; This does not cover `wormhole-transceiver-state`, which cannot be updated
(define-trait transfer-trait (
  ;; Transfer state and funds of `wormhole-transceiver` to caller
  ;; Fails if caller is not successor contract
  (transfer-state ()
    (response {
      pauser: principal,          ;; Account which can pause this contract
      token-contract: principal,  ;; SIP-10 token contract
    } uint))))