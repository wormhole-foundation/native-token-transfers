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
    (response uint uint))
  ;; Validate incoming VAA to unlock tokens
  ;; On success, returns `(ok ...)` with the details needed for unlocking
  ;; On failure, returns `(err code)`
  (parse-and-verify-token-transfer ((buff 4096))
    (response {
      source-chain: (buff 2),
      source-ntt-manager: (buff 32),
      recipient-ntt-manager: (buff 32),
      ntt-manager-payload: (buff 1024),
      transceiver-payload: (optional (buff 1024)),
      uid: (buff 32) ;; Unique identifier for the message to prevent replay
    } uint))))