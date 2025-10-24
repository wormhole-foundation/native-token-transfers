(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; Used by NTT manager to send messages to Transceivers
(define-trait transceiver-trait (
  ;; Get associated contracts
  (get-token-contract () (response principal uint))
  (get-state-contract () (response principal uint))
  (get-ntt-manager () (response principal uint))
  (get-ntt-manager-state-contract () (response principal uint))
  ;; Get latest version of NTT manager from state contract
  (get-active-contract () (response principal uint))
  ;; ID that NTT manager will use to identify tranceiver's protocol
  ;;   u1 - Wormhole
  ;;   u2 - Axelar
  (get-protocol-id () (response uint uint))
  ;; For protocols limited to 32-byte addressing, get the 32-byte address from the Stacks principal
  ;; May not be necessary for all messaging protocols
  (get-addr32 (principal) (response (buff 32) uint))
  ;; Send message to Wormhole Guardians that Stacks tokens were locked and transferred
  ;; On success, returns `(ok sequence)`
  ;; On failure, returns `(err code)`
  (send-token-transfer (
      (buff 1024) ;; NTT manager payload
      (buff 2)    ;; Recipient chain
      (buff 32)   ;; Recipient NTT manager
      (buff 32))  ;; Refund address
    (response uint uint))))
