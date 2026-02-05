(use-trait protocol-send-trait .protocol-send-trait-v1.send-trait)

;; Used by NTT manager to send messages to transceivers
(define-trait transceiver-trait (
  ;; Get associated contracts
  (get-token-contract () (response principal uint))
  (get-state-contract () (response principal uint))
  (get-ntt-manager () (response principal uint))
  (get-ntt-manager-state-contract () (response principal uint))
  ;; Get latest version of transceiver from state contract
  (get-active-contract () (response principal uint))
  ;; Get latest version protocol contract responsible for sending message to network
  (get-protocol-contract () (response principal uint))
  ;; ID that NTT manager will use to identify tranceiver's protocol
  ;;   u1 - Wormhole
  ;;   u2 - Axelar
  (get-protocol-id () (response uint uint))
  ;; Send message to network that tokens have been locked/burned
  ;; On success, returns `(ok sequence)`
  ;; On failure, returns `(err code)`
  (send-token-transfer (
      <protocol-send-trait> ;; Protocol to send message over
      (buff 1024) ;; NTT manager payload
      (buff 2)    ;; Recipient chain
      (buff 32)   ;; Recipient NTT manager
      (buff 32))  ;; Refund address
    (response uint uint))))
