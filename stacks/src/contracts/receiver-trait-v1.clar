(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait ntt-manager-trait .ntt-manager-trait-v1.ntt-manager-trait)

;; Used by to recieve messages from off-chain relayers
(define-trait receiver-trait (
  ;; Process payload for NTT manager
  ;; Transceiver has already parsed and verified VAA and extracted necessary fields
  (receive-token-transfer (
      <ntt-manager-trait> ;; NTT manager
      <sip-010-trait>     ;; Token contract
      (buff 4096))        ;; VAA as bytes
    (response {
      source-chain: (buff 2),
      sender: (buff 32),
      recipient-addr32: (buff 32),
      recipient: principal,
      amount: uint,
      uid: (buff 32)
    } uint))))
